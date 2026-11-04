import type { NotificationMessage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { notifyRun } from "./run-notifications.js";

vi.mock("./notification-identity.js", () => ({ notificationIdentity: async () => undefined }));
const { recordInboxNotification } = vi.hoisted(() => ({
  recordInboxNotification: vi.fn(async () => undefined),
}));
vi.mock("@rakazo/db", () => ({
  countUnreadInboxChats: async () => 2,
  recordInboxNotification,
  runAsTenant: (_tenant: unknown, work: () => unknown) => work(),
}));

const run = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  trigger: "user",
};

const message: NotificationMessage = {
  kind: "completion",
  title: "Scout finished",
  body: "The report is ready.",
  botId: "bot-1",
  threadId: "thread-1",
  runId: "run-1",
};

function deps({
  notifyOnFinish = true,
  groupId = null as string | null,
  publish = vi.fn(async () => undefined),
} = {}) {
  const send = vi.fn(async () => undefined);
  const value = {
    prisma: {
      routine: { findUnique: async () => null },
      run: {
        findFirst: async () => ({
          bot: { id: "bot-1", name: "Scout", color: "#000000", avatarSet: "", notifyOnFinish },
          thread: { groupId },
        }),
      },
    },
    events: { publishChatAlert: publish },
    notifications: { send },
  } as unknown as ExecutorDeps;
  return { value, publish, send };
}

describe("notifyRun chat alerts", () => {
  it("publishes the alert for open apps alongside the push", async () => {
    const { value, publish, send } = deps();
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledWith("user-1", {
      kind: "completion",
      title: "Scout finished",
      body: "The report is ready.",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("names the group a bot's alert came from", async () => {
    const { value, publish } = deps({ notifyOnFinish: false, groupId: "group-1" });
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledWith("user-1", expect.objectContaining({ groupId: "group-1" }));
  });

  it("publishes nothing for a muted chat", async () => {
    const { value, publish, send } = deps({ notifyOnFinish: false });
    await notifyRun(value, run, message);
    expect(publish).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("never holds up or blocks the push", async () => {
    const { value, send } = deps({ publish: vi.fn(() => new Promise<undefined>(() => {})) });
    await notifyRun(value, run, message);
    expect(send).toHaveBeenCalledOnce();
    const failing = deps({ publish: vi.fn(async () => Promise.reject(new Error("down"))) });
    await notifyRun(failing.value, run, message);
    expect(failing.send).toHaveBeenCalledOnce();
  });

  it("still pushes where open apps have no alert publisher", async () => {
    const { value, send } = deps();
    delete (value.events as { publishChatAlert?: unknown }).publishChatAlert;
    await notifyRun(value, run, message);
    expect(send).toHaveBeenCalledOnce();
  });

  it("publishes even where phones have no push provider", async () => {
    const { value, publish } = deps();
    delete (value as { notifications?: unknown }).notifications;
    await notifyRun(value, run, message);
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe("notifyRun and the bell", () => {
  it("lists finished work only where the bot would alert", async () => {
    recordInboxNotification.mockClear();
    await notifyRun(deps().value, run, message);
    expect(recordInboxNotification).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      groupId: null,
      runId: "run-1",
      kind: "completion",
    });
    recordInboxNotification.mockClear();
    await notifyRun(deps({ notifyOnFinish: false }).value, run, message);
    expect(recordInboxNotification).not.toHaveBeenCalled();
  });

  it("lists every request, even from a bot whose alerts are off, and says what it waits for", async () => {
    recordInboxNotification.mockClear();
    const { value, send } = deps({ notifyOnFinish: false });
    await notifyRun(value, run, { ...message, kind: "help", need: "approval" });
    expect(recordInboxNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "approval" }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("never holds up the push when the bell can't record", async () => {
    recordInboxNotification.mockRejectedValueOnce(new Error("database unavailable"));
    const { value, send } = deps();
    await notifyRun(value, run, message);
    expect(send).toHaveBeenCalledOnce();
  });
});
