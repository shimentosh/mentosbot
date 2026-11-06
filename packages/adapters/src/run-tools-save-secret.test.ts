import type { MessageBlock } from "@rakazo/contracts";
import { createStreamingRedactor } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { secretTools } from "./run-tools-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const KEY = "fake-sheets-key-0123456789";

type Stored = { id: string; role: string; authorUserId: string | null; blocks: MessageBlock[] };

function setup(messages: Stored[]) {
  const db = fakeDatabase();
  const message = {
    findMany: vi.fn(
      async ({ where }: { where: { role: string; OR: { authorUserId: string | null }[] } }) =>
        messages.filter(
          (row) =>
            row.role === where.role &&
            where.OR.some((author) => author.authorUserId === row.authorUserId),
        ),
    ),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
        messages.find((row) => row.id === where.id)!.blocks = data.blocks;
      },
    ),
  };
  const append = vi.fn(async () => ({}));
  const ctx = {
    deps: {
      prisma: Object.assign(db.prisma, { message }),
      secretStore,
      events: { append },
    },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", botId: "bot-1" },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    secrets: [] as string[],
    state: { reply: { pendingProgress: "", redactor: createStreamingRedactor([]) } },
  } as unknown as RunContext;
  const save = (args: Record<string, unknown>) =>
    secretTools.save_secret!(ctx, {
      args,
      finish: async (result: unknown) => result,
    } as unknown as ToolCall);
  return { db, ctx, messages, append, save };
}

const pasted = (text: string, authorUserId: string | null = null): Stored => ({
  id: "message-1",
  role: "user",
  authorUserId,
  blocks: [{ kind: "text", text }],
});

describe("save_secret", () => {
  it("saves a key the user pasted, then replaces it in their message", async () => {
    const { db, ctx, messages, append, save } = setup([
      pasted(`here is the sheets key ${KEY} keep it`),
    ]);
    const result = await save({
      credential: { name: "sheets-key", auth: { type: "command" } },
      value: KEY,
    });

    expect(result).toEqual({
      saved: expect.objectContaining({ name: "sheets-key" }),
      removedFromChat: true,
    });
    const [row] = db.rows();
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe(KEY);
    expect(messages[0]!.blocks).toEqual([
      { kind: "text", text: "here is the sheets key [saved to vault as sheets-key] keep it" },
    ]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.message.updated",
        payload: { messageId: "message-1", role: "user", blocks: messages[0]!.blocks },
      }),
    );
    expect(append).toHaveBeenCalledWith(expect.not.objectContaining({ runId: expect.anything() }));
    expect(ctx.secrets).toContain(KEY);
  });

  it.each([
    ["a bot's message", { ...pasted(KEY), role: "bot" }],
    ["a teammate's message", pasted(KEY, "teammate-1")],
  ])("refuses a value that only appears in %s", async (_label, message) => {
    const { db, messages, save } = setup([message as Stored]);
    const result = await save({
      credential: { name: "sheets-key", auth: { type: "command" } },
      value: KEY,
    });

    expect(result).toEqual({ error: expect.stringContaining("request_secret") });
    expect(db.rows()).toEqual([]);
    expect(messages[0]!.blocks).toEqual([{ kind: "text", text: KEY }]);
  });

  it("leaves a login to request_secret's card", async () => {
    const { db, save } = setup([pasted(KEY)]);
    const result = await save({
      credential: { name: "site", origin: "https://example.com", auth: { type: "login" } },
      value: KEY,
    });

    expect(result).toEqual({ error: "Use request_secret for a login, card or contact" });
    expect(db.rows()).toEqual([]);
  });

  it("keeps a saved credential unless the user asked to replace it", async () => {
    const next = "fake-sheets-key-rotated-9876";
    const { db, save } = setup([pasted(`${KEY} and later ${next}`)]);
    const credential = { name: "sheets-key", auth: { type: "command" } };
    await save({ credential, value: KEY });

    expect(await save({ credential, value: next })).toEqual({
      error: expect.stringContaining("already saved"),
    });
    await save({ credential, value: next, replace: true });
    const [row] = db.rows();
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe(next);
  });
});
