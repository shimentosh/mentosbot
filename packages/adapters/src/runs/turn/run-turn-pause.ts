import { displayName, redactSecrets, TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import { MAX_APPROVAL_DETAIL_LENGTH, truncate } from "../../approvals/approval-ask.js";
import { scheduleComputerSleep } from "../../computers/computer-idle.js";
import { holdComputerExecutionLeaseForTakeover } from "../../computers/computer-lifecycle.js";
import { reportBotMessageWait } from "../../messaging/bot-messages.js";
import { scheduleRunSecretsExpiry } from "../../secrets/run-secrets-expiry.js";
import type { RunContext } from "../assembly/run-context.js";
import { persistTurnCheckpoint } from "../assembly/run-context.js";
import { publishMessage } from "../assembly/run-messages.js";
import { enqueueSteeringContinuation, renewRunLease } from "../lifecycle/run-lifecycle.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import {
  canPublishDurableNarration,
  publishInterimMessage,
  publishMidTurnNarration,
  publishNarrationBeforeAsk,
} from "../lifecycle/run-progress.js";
import { clampUserProgressMessage } from "../lifecycle/user-progress.js";
import { wakeRun } from "../wakeups/wake-run.js";
import type { RuntimeEvent } from "./run-turn.js";

export async function pauseForAnswer(ctx: RunContext, event: RuntimeEvent<"ask">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  await publishNarrationBeforeAsk(ctx);
  const safeText = redactSecrets(event.text, ctx.secrets);
  // The bot's own words under its question, capped like an approval card's detail.
  const safeDetail = event.detail
    ? truncate(redactSecrets(event.detail, ctx.secrets), MAX_APPROVAL_DETAIL_LENGTH)
    : event.detail;
  const safeActions = event.actions?.map((action) => ({
    id: action.id,
    label: redactSecrets(action.label, ctx.secrets),
  }));
  const previewImages = await askPreviewImages(deps, run, event.previewImages);
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    onPaused: scheduleRunSecretsExpiry(deps.jobs, runId),
    blocks: [
      {
        kind: "ask",
        text: safeText,
        detail: safeDetail,
        // A runtime ask's detail is prose the bot wrote, never tool arguments.
        ...(safeDetail ? { detailFormat: "text" as const } : {}),
        status: "pending",
        actions: safeActions,
        ...(event.preview !== undefined
          ? { preview: redactSecrets(event.preview, ctx.secrets) }
          : {}),
        ...(event.previewLimit !== undefined ? { previewLimit: event.previewLimit } : {}),
        ...(event.previewLimits
          ? {
              previewLimits: event.previewLimits.map((entry) => ({
                label: redactSecrets(entry.label, ctx.secrets),
                max: entry.max,
              })),
            }
          : {}),
        ...(previewImages.length ? { previewImages } : {}),
        ...(event.multiple ? { multiple: true as const } : {}),
        ...(event.other ? { other: true as const } : {}),
      },
    ],
    // Keep unredacted labels on the run for resume; message blocks stay redacted.
    offeredActions: event.actions,
  });
  if (!paused) return;
  await enqueueSteeringContinuation(deps, paused.continuationRunId);
  await reportBotMessageWait(deps, run, bot, safeText, ctx.attempt.id);
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs an answer`,
    body: safeText,
    botId: bot.id,
    threadId: thread.id,
  });
}

export async function pauseForTakeover(ctx: RunContext, event: RuntimeEvent<"takeover">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  const { reply } = ctx.state;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  // The user takes over the computer's screen, so it must be up before the run waits.
  await ctx.computer.get("takeover");
  const safeReason = redactSecrets(event.reason, ctx.secrets);
  // Publish pending narration as tagged mid-turn progress so reconciliation
  // does not treat pre-takeover text as the delegated final result.
  await publishMidTurnNarration(ctx);
  if (reply.assembled.trim()) {
    const narration = clampUserProgressMessage(redactSecrets(reply.assembled, ctx.secrets));
    if (narration && canPublishDurableNarration(ctx)) {
      await publishInterimMessage(ctx, narration);
    } else if (narration) {
      reply.discardedMidTurnNarration = true;
      reply.lastDiscardedMidTurnNarration = narration;
    }
    reply.assembled = "";
    reply.hasStreamedText = false;
    reply.pendingProgress = "";
  }
  // Give the user a full idle period to answer before the computer may suspend.
  scheduleComputerSleep(deps.jobs, ctx.computer.stored.id);
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: safeReason }],
    true,
  );
  await ctx.computer.checkpoint.flush();
  if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, ctx.computer.lease))) {
    throw new Error("Computer lease expired before takeover");
  }
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForTakeover({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    reason: safeReason,
  });
  if (!paused) return;
  if (typeof paused === "object") {
    await wakeRun(deps.jobs, paused.continuationRunId);
    return;
  }
  ctx.state.lease.retainComputer = true;
  await notifyRun(deps, run, {
    kind: "takeover",
    title: `${displayName(bot.name, "Bot")} needs you on the screen`,
    body: safeReason,
    botId: bot.id,
    threadId: thread.id,
  });
}

/**
 * The images a draft carries, in the order asked: only images in this Space that this bot made or
 * its owner added. Anything else is left off the card rather than failing the question.
 */
export async function askPreviewImages(
  deps: Pick<RunContext["deps"], "prisma">,
  run: { spaceId: string; botId: string; userId: string },
  ids: string[] | undefined,
): Promise<Array<{ artifactId: string; name: string; mimeType: string }>> {
  if (!ids?.length) return [];
  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      spaceId: run.spaceId,
      mimeType: { startsWith: "image/" },
      OR: [{ botId: run.botId }, { userId: run.userId }],
    },
    select: { id: true, name: true, mimeType: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ artifactId: id, name: row.name, mimeType: row.mimeType }] : [];
  });
}
