import type { NotificationMessage } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  isBackgroundRunTrigger,
  plainTextFromMarkdown,
  redactSecrets,
  truncatedPlainText,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { countUnreadInboxChats, recordInboxNotification, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { notificationIdentity } from "./notification-identity.js";

const COMPLETION_NOTIFICATION_MAX_CHARS = 180;

export async function runNotificationsEnabled(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
): Promise<boolean> {
  return (await runNotice(prisma, run)).enabled;
}

async function runNotice(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string },
  routineId?: string | null,
): Promise<{
  enabled: boolean;
  groupId: string | null;
  bot?: { id: string; name: string; color: string; avatarSet: string };
}> {
  // A routine carries its own notify setting, which decides on its failures.
  const routine = routineId
    ? await prisma.routine.findUnique({ where: { id: routineId }, select: { notify: true } })
    : null;
  const source = await prisma.run.findFirst({
    where: {
      botId: run.botId,
      threadId: run.threadId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
    select: {
      bot: { select: { id: true, name: true, color: true, avatarSet: true, notifyOnFinish: true } },
      thread: { select: { groupId: true } },
    },
  });
  if (!source) return { enabled: false, groupId: null };
  return {
    enabled: routine ? routine.notify : Boolean(source.thread.groupId || source.bot.notifyOnFinish),
    groupId: source.thread.groupId,
    bot: source.bot,
  };
}

export async function notifyRun(
  deps: ExecutorDeps,
  run: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
    routineId?: string | null;
    id?: string;
  },
  message: NotificationMessage,
  options: { retryOnFailure?: boolean } = {},
) {
  if (
    (!deps.notifications && !deps.events.publishChatAlert) ||
    (isBackgroundRunTrigger(run.trigger) && message.kind !== "help" && message.kind !== "takeover")
  )
    return;
  const routineId = message.kind === "failure" ? run.routineId : null;
  const notice = await runNotice(deps.prisma, run, routineId).catch((error) => {
    if (options.retryOnFailure) throw error;
    getLogger().error("notification preference lookup", error);
    return null;
  });
  await recordForBell(deps.prisma, run, message, notice);
  if (!notice?.enabled) return;
  publishChatAlert(deps.events, run, message, notice.groupId);
  if (!deps.notifications) return;
  // The icon shows what the inbox shows: unread chats across the user's Spaces. Without a
  // count the push leaves the badge as it is.
  const badge = await countUnreadInboxChats(deps.prisma, {
    userId: run.userId,
    spaceId: run.spaceId,
  }).catch((error) => {
    getLogger().error("unread chat count", error);
    return undefined;
  });
  const bot = notice.bot;
  const sender = bot && (await notificationIdentity(bot));
  await deps.notifications
    .send(
      {
        ...message,
        ...(sender ? { sender } : {}),
        ...(notice.groupId ? { groupId: notice.groupId } : {}),
        ...(badge === undefined ? {} : { badge }),
      },
      {
        operationId: "notify",
        traceId: run.botId,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        signal: new AbortController().signal,
      },
    )
    .catch((error) => {
      if (options.retryOnFailure) throw error;
      getLogger().error("run notification", error);
    });
}

/**
 * The bell lists every request a run makes of its person, whatever the bot's alert setting, since
 * the run waits for it; finished and failed work only when that setting would alert. A failure to
 * record never holds up the run or its push.
 */
async function recordForBell(
  prisma: PrismaClient,
  run: { spaceId: string; userId: string; botId: string; threadId: string; id?: string },
  message: NotificationMessage,
  notice: { enabled: boolean; groupId: string | null } | null,
) {
  const asks = message.kind === "help" || message.kind === "takeover";
  if (!notice || (!asks && !notice.enabled)) return;
  const kind = message.kind === "help" ? (message.need ?? "answer") : message.kind;
  try {
    await runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
      recordInboxNotification(prisma, {
        userId: run.userId,
        spaceId: run.spaceId,
        botId: message.botId,
        threadId: message.threadId,
        groupId: notice.groupId,
        runId: message.runId ?? run.id ?? null,
        kind,
      }),
    );
  } catch (error) {
    getLogger().error("bell notification record", error);
  }
}

/** Open apps alert from the same message. Not awaited, so it never holds up the push. */
export function publishChatAlert(
  events: Pick<ThreadEvents, "publishChatAlert"> | undefined,
  run: { spaceId: string; userId: string },
  message: NotificationMessage,
  groupId: string | null,
) {
  void (async () =>
    events?.publishChatAlert?.(run.userId, {
      kind: message.kind,
      title: truncatePlainText(message.title, COMPLETION_NOTIFICATION_MAX_CHARS),
      body: truncatePlainText(message.body, COMPLETION_NOTIFICATION_MAX_CHARS),
      spaceId: run.spaceId,
      botId: message.botId,
      threadId: message.threadId,
      ...(groupId ? { groupId } : {}),
    }))().catch((error) => getLogger().error("chat alert publish", error));
}

export function runSendsFinishNotification(trigger: string): boolean {
  return trigger !== "created" && !isBackgroundRunTrigger(trigger);
}

/** User-facing text for completion notifications; empty when only tool/step activity remains. */
export function completionNotificationBody(assembled: string, blocks: MessageBlock[]): string {
  if (assembled) return assembled;
  return blocks
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Push body: Markdown stripped, then truncated so a cut cannot land inside a marker. A status card
 * the run showed leads, since it names what was done.
 */
export function completionNotificationPreview(text: string, cardPreview = ""): string {
  return truncatedPlainText(
    [cardPreview, text].filter(Boolean).join(" · "),
    COMPLETION_NOTIFICATION_MAX_CHARS,
  );
}

/** A secret card can ask for a code or a login, so the title stays generic and the label short. */
export function secretAskNotification(botName: string, label: string, runSecrets: string[]) {
  // Strip and redact before shortening so no protected value is left half-shown.
  const text = plainTextFromMarkdown(redactSecrets(label, runSecrets), { maxSource: Infinity });
  const body = truncatePlainText(
    redactSecrets(text, runSecrets),
    COMPLETION_NOTIFICATION_MAX_CHARS,
  );
  return { title: `${botName} needs an answer`, body };
}

export function completionMarksUnread(
  trigger: string,
  text: string,
  userFacingPeerReply = false,
): boolean {
  if (trigger === "bot_message") return userFacingPeerReply;
  if (isBackgroundRunTrigger(trigger)) return false;
  return (trigger !== "routine" && trigger !== "reaction") || Boolean(text);
}

export function subagentMarksUnread(
  trigger: string,
  status: "running" | "completed" | "failed",
  userFacingPeerReply = false,
) {
  if (isBackgroundRunTrigger(trigger)) return false;
  return (
    status === "failed" ||
    (trigger === "bot_message" && userFacingPeerReply) ||
    (trigger !== "routine" && trigger !== "bot_message")
  );
}
