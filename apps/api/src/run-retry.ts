import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isOwnerStartedRun } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * Run a failed reply again: the same task, for the same message, as a new run. Only the
 * person's own failed request can be retried, and only while it is still the last thing that
 * happened in the chat. A second tap finds the first retry and queues nothing.
 */
export async function retryFailedRun(
  deps: { prisma: PrismaClient; jobs: Pick<JobPublisher, "enqueue"> },
  actor: Pick<Actor, "spaceId" | "userId">,
  threadId: string,
  runId: string,
): Promise<void> {
  const queued = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    const failed = await tx.run.findFirst({
      where: {
        id: runId,
        spaceId: actor.spaceId,
        threadId,
        userId: actor.userId,
        status: "failed",
      },
      select: {
        botId: true,
        trigger: true,
        createdAt: true,
        sourceMessageId: true,
        sourceMessage: { select: { role: true } },
        task: { select: { prompt: true } },
      },
    });
    if (!failed) throw new ORPCError("NOT_FOUND");
    if (
      !failed.sourceMessageId ||
      !isOwnerStartedRun(failed.trigger, failed.sourceMessage?.role === "user")
    )
      throw new ORPCError("BAD_REQUEST", { message: "This reply cannot be tried again." });
    const clientNonce = `retry:${runId}`;
    const prior = await tx.run.findFirst({
      where: { spaceId: actor.spaceId, clientNonce },
      select: { id: true },
    });
    if (prior) return undefined;
    const later = await tx.run.findFirst({
      where: {
        threadId,
        id: { not: runId },
        OR: [{ status: { in: [...ACTIVE_RUN_STATUSES] } }, { createdAt: { gt: failed.createdAt } }],
      },
      select: { id: true },
    });
    if (later)
      throw new ORPCError("CONFLICT", {
        message: "The chat has moved on. Send your message again.",
      });
    const task = await tx.task.create({
      data: {
        spaceId: actor.spaceId,
        botId: failed.botId,
        threadId,
        userId: actor.userId,
        prompt: failed.task.prompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: actor.spaceId,
        botId: failed.botId,
        threadId,
        userId: actor.userId,
        taskId: task.id,
        status: "queued",
        trigger: "follow_up",
        sourceMessageId: failed.sourceMessageId,
        clientNonce,
      },
    });
    return run.id;
  });
  if (!queued) return;
  // The run reconciler recovers a queued run after an enqueue failure.
  await deps.jobs.enqueue(runContinueJob(queued)).catch(() => {
    getLogger().warn("retry run deferred to reconciliation");
  });
}
