import { describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

describe("owner words", () => {
  const ownerWords = (
    trigger: string,
    blocks: unknown[],
    role = "user",
    later: {
      asked?: unknown[][];
      steered?: { role: string; authorUserId: string; blocks: unknown[] }[];
      ticket?: {
        ownerRequest: string | null;
        createdByUserId: string | null;
        comments: { body: string }[];
      };
      taskPrompt?: string;
    } = {},
  ) =>
    createRunTrustLoaders(
      {
        prisma: {
          message: {
            findMany: async () => (later.asked ?? []).map((asked) => ({ blocks: asked })),
          },
          steeringMessage: {
            findMany: async () => (later.steered ?? []).map((message) => ({ message })),
          },
          ticket: { findFirst: async () => later.ticket ?? null },
        },
      } as unknown as ExecutorDeps,
      {
        run: { userId: "user-1", spaceId: "space-1", trigger },
        runId: "run-1",
        botId: "bot-1",
        taskPrompt: later.taskPrompt ?? "prompt",
        ownerStartedRun: trigger === "user",
        messagingChannelRun: false,
        sourceMessage: { role, blocks },
        connectedPlugins: [],
      },
    ).loadOwnerWords();

  const delivery = (fields: Record<string, unknown>) => [
    {
      kind: "bot_message_received",
      fromBotId: "bot-2",
      fromBotName: "Manager",
      text: "do it",
      ...fields,
    },
  ];

  const draftCard = (fields: Record<string, unknown> = {}) => ({
    kind: "ask",
    text: "Publish these four replies?",
    preview: "1) The useful part is the impact.",
    actions: [
      { id: "choice-1", label: "Post now" },
      { id: "choice-2", label: "Not now" },
    ],
    status: "answered",
    answer: "choice-1",
    answeredByOwner: true,
    ...fields,
  });

  it("reads the person's request a teammate's delivery carries", async () => {
    await expect(
      ownerWords("bot_message", delivery({ userRequest: "publish the post" })),
    ).resolves.toBe("publish the post");
  });

  it("never takes a teammate's own message as the person's words", async () => {
    await expect(ownerWords("bot_message", delivery({}))).resolves.toBe("");
  });

  it("adds the person's answer with the question and the draft it answered", async () => {
    const words = await ownerWords("user", [{ kind: "text", text: "Reply on X" }], "user", {
      asked: [[{ kind: "text", text: "Here they are" }, draftCard()]],
    });
    expect(words).toBe(
      [
        "Reply on X",
        "Asked: Publish these four replies?\nDraft on the card:\n1) The useful part is the impact.\nThey answered: Post now",
      ].join("\n\n"),
    );
  });

  it("uses the draft as the person edited it", async () => {
    const words = await ownerWords("user", [], "user", {
      asked: [[draftCard({ editedPreview: "1) Edited." })]],
    });
    expect(words).toContain("Draft on the card:\n1) Edited.");
    expect(words).not.toContain("The useful part");
  });

  it("leaves out answers from anyone else and cards that act on their own", async () => {
    const words = await ownerWords("user", [], "user", {
      asked: [
        [
          draftCard({ answeredByOwner: undefined }),
          draftCard({ approvalEffectId: "effect-1" }),
          draftCard({ input: "secret" }),
          { kind: "ask", text: "Which city?", status: "pending" },
        ],
      ],
    });
    expect(words).toBe("");
  });

  it("adds what the person sent while the run worked, never a channel's or a teammate's", async () => {
    const words = await ownerWords(
      "bot_message",
      delivery({ userRequest: "draft replies" }),
      "user",
      {
        steered: [
          {
            role: "user",
            authorUserId: "user-1",
            blocks: [{ kind: "text", text: "post all four" }],
          },
          {
            role: "user",
            authorUserId: "user-2",
            blocks: [{ kind: "text", text: "post mine too" }],
          },
          {
            role: "user",
            authorUserId: "user-1",
            blocks: [
              { kind: "channel_message", text: "from a channel" },
              { kind: "text", text: "from a channel" },
            ],
          },
          { role: "bot", authorUserId: "user-1", blocks: [{ kind: "text", text: "bot text" }] },
        ],
      },
    );
    expect(words).toBe("draft replies\n\npost all four");
  });

  it("reads the person's words behind the ticket a run was woken for", async () => {
    const wake =
      "Work on ticket RAK-7. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.";
    const ticket = {
      ownerRequest: "ship the four replies",
      createdByUserId: "user-1",
      comments: [{ body: "post them today" }],
    };
    await expect(ownerWords("tickets", [], "user", { taskPrompt: wake, ticket })).resolves.toBe(
      "ship the four replies\n\npost them today",
    );
    await expect(
      ownerWords("tickets", [], "user", {
        taskPrompt: wake,
        ticket: { ...ticket, createdByUserId: "user-2" },
      }),
    ).resolves.toBe("post them today");
    await expect(
      ownerWords("tickets", [], "user", { taskPrompt: "Work on something else", ticket }),
    ).resolves.toBe("");
  });
});
