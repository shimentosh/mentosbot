import type { JobPublisher } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import {
  hasLab,
  isTicketCompletedStatus,
  resolveLabs,
  TicketStatusSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { wakeRun } from "./wake-run.js";
import { ticketWakePrompt } from "./wakes.prompt.js";

/** How every ticket wake prompt starts (see ticketWakePrompt). */
const TICKET_WAKE_PREFIX = "Work on ticket ";

/** The ticket number a ticket run was woken for, read back from the prompt the wake wrote. */
export function ticketNumberFromWakePrompt(prompt: string): number | undefined {
  if (!prompt.startsWith(TICKET_WAKE_PREFIX)) return undefined;
  const match = /^[^\s-]+-(\d+)\./.exec(prompt.slice(TICKET_WAKE_PREFIX.length));
  const number = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; deploymentLabs?: readonly LabFeature[] },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  const run = await deps.prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findFirst({
      where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
      include: { board: { select: { ticketPrefix: true } } },
    });
    if (!ticket) return null;
    const status = TicketStatusSchema.safeParse(ticket.status);
    if (!status.success || isTicketCompletedStatus(status.data)) return null;
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
      select: { id: true, userId: true, thread: { select: { id: true } } },
    });
    if (!bot?.thread) return null;
    const owner = await tx.user.findUnique({ where: { id: bot.userId }, select: { labs: true } });
    if (!hasLab(resolveLabs(owner?.labs, deps.deploymentLabs), "board")) return null;
    const task = await tx.task.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        prompt: ticketWakePrompt(`${ticket.board.ticketPrefix}-${ticket.number}`),
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId: bot.thread.id,
        userId: bot.userId,
        taskId: task.id,
        trigger: "tickets",
        status: "queued",
      },
    });
  });
  if (!run) return;
  await wakeRun(deps.jobs, run.id);
}
