import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { WAITING_ON_USER_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "./client.js";

export type InboxNeedKind = "approval" | "answer" | "takeover";
export type InboxNoticeKind = "completion" | "failure";
export type InboxKind = InboxNeedKind | InboxNoticeKind;

/** How long finished and failed work stays in the bell. */
export const INBOX_RECENT_DAYS = 14;
/** Older rows serve nothing and are removed as new ones arrive. */
export const INBOX_RETENTION_DAYS = 90;
const NEEDS_LIMIT = 50;
const RECENT_LIMIT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InboxBot {
  id: string;
  name: string;
  color: string;
  avatarSet: string;
}

export interface InboxEntry {
  id: string;
  kind: InboxKind;
  spaceId: string;
  spaceName: string;
  bot: InboxBot;
  threadId: string;
  groupId: string | null;
  at: Date;
  read: boolean;
}

export async function recordInboxNotification(
  prisma: PrismaClient,
  input: {
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
    groupId?: string | null;
    runId?: string | null;
    kind: InboxKind;
  },
): Promise<void> {
  await prisma.inboxNotification.create({
    data: {
      userId: input.userId,
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      groupId: input.groupId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
    },
  });
  await prisma.inboxNotification.deleteMany({
    where: {
      userId: input.userId,
      createdAt: { lt: new Date(Date.now() - INBOX_RETENTION_DAYS * DAY_MS) },
    },
  });
}

const BOT_SELECT = { id: true, name: true, color: true, avatarSet: true } as const;

/**
 * The bell for one person in one organization. What still needs them comes from their runs that
 * wait on them, so it clears the moment a card is answered, on any device; the notification
 * that run sent only says what it waits for. Finished and failed work is listed for two weeks.
 */
export async function listInbox(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<{ needsYou: InboxEntry[]; recent: InboxEntry[]; unread: number }> {
  const space = {
    organizationId: input.organizationId,
    deletingAt: null,
    memberships: { some: { userId: input.userId } },
  };
  const since = new Date(Date.now() - INBOX_RECENT_DAYS * DAY_MS);
  const [waiting, recent, unread] = await Promise.all([
    prisma.run.findMany({
      where: {
        userId: input.userId,
        status: { in: [...WAITING_ON_USER_RUN_STATUSES] },
        space,
        bot: { archivedAt: null },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: NEEDS_LIMIT,
      select: {
        id: true,
        status: true,
        updatedAt: true,
        threadId: true,
        spaceId: true,
        space: { select: { name: true } },
        bot: { select: BOT_SELECT },
        thread: { select: { groupId: true } },
      },
    }),
    prisma.inboxNotification.findMany({
      where: {
        userId: input.userId,
        kind: { in: ["completion", "failure"] },
        createdAt: { gte: since },
        space,
        bot: { archivedAt: null },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_LIMIT,
      include: { space: { select: { name: true } }, bot: { select: BOT_SELECT } },
    }),
    prisma.inboxNotification.count({
      where: {
        userId: input.userId,
        kind: { in: ["completion", "failure"] },
        createdAt: { gte: since },
        readAt: null,
        space,
        bot: { archivedAt: null },
      },
    }),
  ]);
  const asked = waiting.length
    ? await prisma.inboxNotification.findMany({
        where: {
          userId: input.userId,
          runId: { in: waiting.map((run) => run.id) },
          kind: { in: ["approval", "answer", "takeover"] },
        },
        orderBy: { createdAt: "desc" },
        select: { runId: true, kind: true },
      })
    : [];
  const latestAsk = new Map<string, InboxNeedKind>();
  for (const row of asked)
    if (row.runId && !latestAsk.has(row.runId)) latestAsk.set(row.runId, row.kind as InboxNeedKind);
  return {
    needsYou: waiting.map((run) => ({
      id: `run:${run.id}`,
      kind: run.status === "waiting_takeover" ? "takeover" : (latestAsk.get(run.id) ?? "answer"),
      spaceId: run.spaceId,
      spaceName: run.space.name,
      bot: run.bot,
      threadId: run.threadId,
      groupId: run.thread.groupId,
      at: run.updatedAt,
      read: false,
    })),
    recent: recent.map((row) => ({
      id: row.id,
      kind: row.kind as InboxNoticeKind,
      spaceId: row.spaceId,
      spaceName: row.space.name,
      bot: row.bot,
      threadId: row.threadId,
      groupId: row.groupId,
      at: row.createdAt,
      read: row.readAt !== null,
    })),
    unread,
  };
}

export interface ApprovalEntry {
  runId: string;
  spaceId: string;
  spaceName: string;
  bot: InboxBot;
  threadId: string;
  groupId: string | null;
  at: Date;
  ask: { messageId: string; block: Extract<MessageBlock, { kind: "ask" }> } | null;
}

/**
 * The person's runs that wait on them, oldest first, each with the card it asked them to answer:
 * the newest unanswered ask among the run's own messages. A run waiting for a takeover has none.
 */
export async function listApprovals(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<ApprovalEntry[]> {
  const runs = await prisma.run.findMany({
    where: {
      userId: input.userId,
      status: { in: [...WAITING_ON_USER_RUN_STATUSES] },
      space: {
        organizationId: input.organizationId,
        deletingAt: null,
        memberships: { some: { userId: input.userId } },
      },
      bot: { archivedAt: null },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: NEEDS_LIMIT,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      threadId: true,
      spaceId: true,
      space: { select: { name: true } },
      bot: { select: BOT_SELECT },
      thread: { select: { groupId: true } },
    },
  });
  const asking = runs.filter((run) => run.status === "waiting_input").map((run) => run.id);
  const messages = asking.length
    ? await prisma.message.findMany({
        where: { runId: { in: asking }, role: "bot" },
        orderBy: [{ seq: "desc" }],
        select: { id: true, runId: true, blocks: true },
      })
    : [];
  const asks = new Map<string, NonNullable<ApprovalEntry["ask"]>>();
  for (const message of messages) {
    if (!message.runId || asks.has(message.runId)) continue;
    const parsed = MessageBlockSchema.array().safeParse(message.blocks);
    if (!parsed.success) continue;
    const block = parsed.data.find(
      (candidate): candidate is Extract<MessageBlock, { kind: "ask" }> =>
        candidate.kind === "ask" && candidate.status !== "answered",
    );
    if (block) asks.set(message.runId, { messageId: message.id, block });
  }
  return runs.map((run) => ({
    runId: run.id,
    spaceId: run.spaceId,
    spaceName: run.space.name,
    bot: run.bot,
    threadId: run.threadId,
    groupId: run.thread.groupId,
    at: run.updatedAt,
    ask: asks.get(run.id) ?? null,
  }));
}

export async function markInboxRead(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<void> {
  await prisma.inboxNotification.updateMany({
    where: {
      userId: input.userId,
      readAt: null,
      space: { organizationId: input.organizationId },
    },
    data: { readAt: new Date() },
  });
}
