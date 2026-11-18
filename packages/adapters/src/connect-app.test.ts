import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { ConnectionCatalogItem, MessageBlock } from "@rakazo/contracts";
import type * as db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectApp } from "./connect-app.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { connectorTool } from "./run-tools-integrations.js";

const stored = vi.hoisted(() => [] as { blocks: MessageBlock[]; clientNonce: string }[]);
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  createThreadMessageInTransaction: vi.fn(async (_tx, input) => {
    stored.push(input);
    return { id: "card" };
  }),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1, firstResponse: true })),
}));
const entry: ConnectionCatalogItem = {
  connectorId: "fake",
  slug: "gmail",
  name: "Gmail",
  logo: null,
  connected: false,
  noAuth: false,
};
function fixture(items = [entry]) {
  const tx = {
    $executeRaw: vi.fn(),
    message: {
      findMany: vi.fn(async () => stored),
      findFirst: vi.fn(
        async ({ where }: { where: { clientNonce: string } }) =>
          stored.find((message) => message.clientNonce === where.clientNonce) ?? null,
      ),
    },
  };
  const deps = {
    prisma: { $transaction: vi.fn(async (fn) => fn(tx)) },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof connectApp>[0];
  const catalog = vi.fn(async () => items);
  const providers = [
    { describe: () => ({ id: "fake" }), catalog },
  ] as unknown as ManagedConnectorProvider[];
  const context = {
    spaceId: "space",
    userId: "user",
    botId: "bot",
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  } as AdapterContext;
  const target = { id: "run", spaceId: "space", botId: "bot", threadId: "chat" };
  return {
    deps,
    providers,
    context,
    target,
    catalog,
    call: (app: unknown = "Gmail", effect = "effect") =>
      connectApp(deps, providers, context, target, app, effect),
  };
}
beforeEach(() => {
  stored.length = 0;
  vi.clearAllMocks();
});
describe("connect_app execution", () => {
  it("uses only catalog fields and actor context", async () => {
    const f = fixture();
    await f.call("GMAIL");
    expect(stored).toEqual([
      {
        threadId: "chat",
        botId: "bot",
        runId: "run",
        role: "bot",
        blocks: [
          {
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "Search, read, draft, and send email.",
            logo: null,
            status: "pending",
          },
        ],
        clientNonce: "connect-app:effect",
      },
    ]);
    expect(f.catalog).toHaveBeenCalledWith(f.context, "GMAIL");
    expect(f.deps.events.notify).toHaveBeenCalledWith("chat", 1, "run");
  });
  it("does not accept model card objects or unknown apps", async () => {
    const f = fixture();
    await f.call({ app: "Gmail", name: "untrusted", logo: "untrusted" });
    expect(await f.call("unavailable")).toHaveProperty("error");
    expect(stored).toHaveLength(0);
  });
  it("returns connected state without posting", async () => {
    const f = fixture([{ ...entry, connected: true }]);
    expect(await f.call()).toMatchObject({ status: "connected" });
    expect(stored).toHaveLength(0);
  });
  it("dedupes replay even after the original card connects", async () => {
    const f = fixture();
    await f.call();
    stored[0]!.blocks = stored[0]!.blocks.map(
      (block) => ({ ...block, status: "connected" }) as MessageBlock,
    );
    await f.call();
    expect(stored).toHaveLength(1);
  });
  it("reuses a pending card from a different effect", async () => {
    const f = fixture();
    await f.call();
    await f.call("gmail", "another-effect");
    expect(stored).toHaveLength(1);
  });
});

it("falls back to the catalog when search does not recognize a featured alias", async () => {
  const f = fixture();
  f.catalog.mockImplementation(async (_context?: unknown, query?: string) =>
    query ? [] : [{ ...entry, slug: "googlecalendar", name: "Google Calendar" }],
  );
  await f.call("gcal");
  expect(stored[0]?.blocks[0]).toMatchObject({
    provider: "googlecalendar",
    name: "Google Calendar",
  });
});

it("treats an app connected through a later provider as connected", async () => {
  const f = fixture();
  const providers = [
    { describe: () => ({ id: "fake" }), catalog: async () => [entry] },
    {
      describe: () => ({ id: "other" }),
      catalog: async () => [{ ...entry, connectorId: "other", connected: true }],
    },
  ] as unknown as ManagedConnectorProvider[];
  const result = await connectApp(f.deps, providers, f.context, f.target, "Gmail", "effect");
  expect(result).toMatchObject({ status: "connected" });
  expect(stored).toHaveLength(0);
});

describe("a connector call whose sign-in ended", () => {
  function run(event: { message: string; reconnectApp?: string }, items = [entry]) {
    const { deps, providers, context, target } = fixture(items);
    const ctx = {
      deps: {
        ...deps,
        connector: {
          async *execute() {
            yield { type: "error" as const, ...event };
          },
        },
        connectors: { managedProviders: () => providers },
      },
      run: target,
      runId: "run",
      bot: { id: "bot" },
      thread: { id: "chat" },
      context,
    } as unknown as RunContext;
    const call = {
      name: "gmail_send",
      args: {},
      executionId: "call-1",
      effectKey: "effect",
      connectorCall: {},
      applied: undefined,
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    return connectorTool(ctx, call);
  }

  it("puts the app's connect card in the chat and tells the bot it is there", async () => {
    const result = (await run({ message: "gmail is gone", reconnectApp: "gmail" })) as {
      error: string;
    };
    expect(stored).toHaveLength(1);
    expect(stored[0]?.blocks[0]).toMatchObject({ kind: "app_connect", provider: "gmail" });
    expect(result.error).toContain("A card to reconnect gmail is now in the chat");
  });

  it("keeps the connector's own error when there is no card to show", async () => {
    expect(await run({ message: "rate limited" })).toEqual({ error: "rate limited" });
    expect(await run({ message: "gmail is gone", reconnectApp: "gmail" }, [])).toEqual({
      error: "gmail is gone",
    });
    expect(stored).toHaveLength(0);
  });
});
