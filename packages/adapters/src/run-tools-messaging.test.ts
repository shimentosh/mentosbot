import { describe, expect, it, vi } from "vitest";

const messageBot = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, botId: "bot-2", name: "Writer", note: "Sent." }),
);
vi.mock("./bot-messages.js", () => ({ messageBot }));

const { messagingTools } = await import("./run-tools-messaging.js");

describe("message_bot", () => {
  it("passes on the person's own words, without secrets", async () => {
    const ctx = {
      deps: {},
      run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId: "u" },
      bot: { id: "bot-1", name: "Manager" },
      secrets: ["sk-test-secret"],
      trust: { loadOwnerWords: async () => "publish it with key sk-test-secret" },
    };
    await messagingTools.message_bot!(
      ctx as never,
      {
        name: "message_bot",
        args: { bot_id: "bot-2", message: "Publish the post." },
        effectKey: "effect-1",
        finish: async (result: unknown) => result,
      } as never,
    );

    expect(messageBot).toHaveBeenCalledWith(
      ctx.deps,
      expect.objectContaining({ id: "run-1" }),
      { id: "bot-1", name: "Manager" },
      expect.objectContaining({
        message: "Publish the post.",
        userRequest: expect.not.stringContaining("sk-test-secret"),
      }),
    );
    expect(messageBot.mock.calls[0]?.[3].userRequest).toContain("publish it with key");
  });
});
