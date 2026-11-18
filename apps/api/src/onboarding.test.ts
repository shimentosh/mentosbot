import type * as db from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, markAppConnected, promptFocus } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[]; markUnread?: boolean }>);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return { id: "posted" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));
function fixture(catalog: unknown[]) {
  posted.length = 0;
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => [{ id: "choice", blocks: [{ kind: "choice", answerId: null }] }]),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "thread" } })) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: {
      managedProviders: () => [{ catalog: async () => catalog }],
      managed: () => ({ catalog: async () => catalog }),
    },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}
describe("onboarding connection suggestions", () => {
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
    // The reply to the user's pick is read; suggestions after the catalog wait stay unread.
    expect(posted[0]?.markUnread).toBe(false);
    expect(posted.slice(1).every((message) => message.markUnread === true)).toBe(true);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([
      expect.objectContaining({ connectorId: "pipedream", provider: "slack", name: "Slack" }),
    ]);
  });
});

describe("promptFocus", () => {
  function focusFixture(options: { introRun?: boolean; blocks?: unknown[] } = {}) {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany = vi.fn(async () =>
      options.blocks ? [{ role: "bot", blocks: options.blocks }] : [],
    ) as never;
    const run = {
      findFirst: vi.fn(async () => (options.introRun ? { id: "intro" } : null)),
    };
    Object.assign(tx, { run });
    return { deps, actor, run };
  }

  it("posts the fixed focus card when the bot has no creation intro", async () => {
    const { deps, actor } = focusFixture();
    await promptFocus(deps, actor, "bot");
    expect(posted.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ kind: "choice" }),
    );
  });

  it("leaves the question to a bot whose creation intro is queued or running", async () => {
    const { deps, actor, run } = focusFixture({ introRun: true });
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([]);
    expect(run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread", trigger: "created" }),
      }),
    );
  });

  it("does not post over a question the bot already asked", async () => {
    const { deps, actor } = focusFixture({
      blocks: [{ kind: "ask", text: "What do you want me for?", status: "answered" }],
    });
    await promptFocus(deps, actor, "bot");
    expect(posted).toEqual([]);
  });
});

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
  ]);
  const blocks = ["composio", "pipedream"].map((connectorId) => ({
    kind: "app_connect",
    connectorId,
    provider: "slack",
    name: "Slack",
    status: "pending",
  }));
  tx.message.findMany = vi.fn(async () => [{ id: "cards", blocks }]) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream");
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "cards" },
    data: { blocks: [blocks[0], { ...blocks[1], status: "connected" }] },
  });
});

it("does not trust a client's connected claim", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: false },
  ]);
  Object.assign(deps.prisma, { message: { findMany: vi.fn() } });
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread");
  expect(deps.prisma.message.findMany).not.toHaveBeenCalled();
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("rejects a thread from another user or space before reading its messages", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, { thread: { findFirst: vi.fn(async () => null) } });
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "other-thread"),
  ).rejects.toThrow();
  expect(deps.prisma.thread.findFirst).toHaveBeenCalledWith({
    where: { id: "other-thread", spaceId: actor.spaceId },
  });
  expect(tx.message.update).not.toHaveBeenCalled();
});

it("updates an accessible group thread and emits its normal update event", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({ id: "group-thread", groupId: "group" })),
    },
  });
  Object.assign(deps.prisma, {
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group",
        name: "Team",
        thread: { id: "group-thread" },
        members: ["bot", "peer"].map((id) => ({ bot: { id, name: id, runs: [] } })),
      })),
    },
  });
  tx.message.findMany = vi.fn(async () => [
    {
      id: "card",
      blocks: [
        { kind: "app_connect", connectorId: "pipedream", provider: "slack", status: "pending" },
      ],
    },
  ]) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "group-thread");
  expect(deps.prisma.chatGroup.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "group", spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    }),
  );
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { threadId: "group-thread" } }),
  );
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "card" },
    data: { blocks: [expect.objectContaining({ status: "connected" })] },
  });
  expect(appendEventInTransaction).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      threadId: "group-thread",
      spaceId: actor.spaceId,
      type: "thread.message.updated",
    }),
  );
  expect(deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
});

it("rejects another user's group even in the same space", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", connected: true },
  ]);
  Object.assign(deps.prisma, {
    thread: {
      findFirst: vi.fn(async () => ({ id: "other-thread", groupId: "other-group" })),
    },
  });
  Object.assign(deps.prisma, { chatGroup: { findFirst: vi.fn(async () => null) } });
  await expect(
    markAppConnected(deps, actor, "bot", "slack", "pipedream", "other-thread"),
  ).rejects.toThrow();
  expect(tx.message.update).not.toHaveBeenCalled();
  expect(deps.prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "bot", spaceId: actor.spaceId, userId: actor.userId } }),
  );
});

it("updates the authorized card's own message even outside the bounded scan", async () => {
  const { deps, actor, tx } = fixture([
    { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
  ]);
  const card = {
    kind: "app_connect",
    connectorId: "pipedream",
    provider: "slack",
    name: "Slack",
    status: "pending",
  };
  tx.message.findMany = vi.fn(async ({ where }: { where: { id?: string; threadId: string } }) =>
    where.id === "middle" && where.threadId === "thread" ? [{ id: "middle", blocks: [card] }] : [],
  ) as never;
  await markAppConnected(deps, actor, "bot", "slack", "pipedream", "thread", "middle");
  expect(tx.message.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "middle", threadId: "thread" } }),
  );
  expect(tx.message.update).toHaveBeenCalledWith({
    where: { id: "middle" },
    data: { blocks: [{ ...card, status: "connected" }] },
  });
});

describe("picking the task back up after a connect card", () => {
  const cardBlocks = [
    {
      kind: "app_connect",
      connectorId: "pipedream",
      provider: "slack",
      name: "Slack",
      status: "pending",
    },
  ];
  function resumeFixture(options: {
    shown?: Record<string, unknown> | null;
    blocking?: boolean;
    written?: boolean;
  }) {
    const { deps, actor, tx } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
    ]);
    const created = { tasks: [] as unknown[], runs: [] as Array<Record<string, unknown>> };
    const run = {
      // The first lookup is the run that showed the card; the second is anything in its way.
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(
          options.shown === undefined
            ? {
                status: "completed",
                trigger: "user",
                sourceMessageId: "asked",
                sourceMessage: { role: "user" },
              }
            : options.shown,
        )
        .mockResolvedValueOnce(options.blocking ? { id: "busy" } : null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.runs.push(data);
        return { id: "resume-run" };
      }),
    };
    Object.assign(tx, {
      run,
      task: {
        create: vi.fn(async ({ data }: { data: unknown }) => {
          created.tasks.push(data);
          return { id: "resume-task" };
        }),
      },
    });
    tx.message.findMany = vi.fn(async () => [
      { id: "card", runId: "shown-run", createdAt: new Date(1000), blocks: cardBlocks },
    ]) as never;
    Object.assign(tx.message, {
      findFirst: vi.fn(async () => (options.written ? { id: "newer" } : null)),
    });
    const enqueue = vi.fn(async () => undefined);
    return { deps: { ...deps, jobs: { enqueue } }, actor, created, enqueue };
  }

  it("queues a follow-up run for the owner's finished request", async () => {
    const { deps, actor, created, enqueue } = resumeFixture({});
    await markAppConnected(deps, actor, "bot", "slack", "pipedream");
    expect(created.tasks).toEqual([
      expect.objectContaining({ prompt: expect.stringContaining("The user connected Slack") }),
    ]);
    expect(created.runs).toEqual([
      expect.objectContaining({
        trigger: "follow_up",
        sourceMessageId: "asked",
        clientNonce: "app-connected:card",
        userId: "user",
      }),
    ]);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "the run that showed the card is still going",
      {
        shown: {
          status: "running",
          trigger: "user",
          sourceMessageId: "asked",
          sourceMessage: { role: "user" },
        },
      },
    ],
    [
      "a routine showed the card",
      {
        shown: {
          status: "completed",
          trigger: "routine",
          sourceMessageId: "asked",
          sourceMessage: { role: "user" },
        },
      },
    ],
    ["the run is not this owner's", { shown: null }],
    ["another run is active or it already resumed", { blocking: true }],
    ["the owner has written since", { written: true }],
  ])("queues nothing when %s", async (_case, options) => {
    const { deps, actor, created, enqueue } = resumeFixture(options);
    await markAppConnected(deps, actor, "bot", "slack", "pipedream");
    expect(created.runs).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues nothing for an onboarding card no run showed", async () => {
    const { deps, actor, tx } = fixture([
      { connectorId: "pipedream", slug: "slack", name: "Slack", connected: true },
    ]);
    tx.message.findMany = vi.fn(async () => [
      { id: "card", runId: null, createdAt: new Date(1000), blocks: cardBlocks },
    ]) as never;
    await expect(
      markAppConnected(deps, actor, "bot", "slack", "pipedream"),
    ).resolves.toBeUndefined();
  });
});
