import { randomUUID } from "node:crypto";
import {
  ensureComputerWorkspaceLayout,
  provisionComputer,
  releaseComputerExecutionLease,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  wakeableComputerRef,
} from "@rakazo/adapters";
import type { Actor, ComputerStatus } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { createRepos, IsolationError, isRecordNotFound, parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RouterDeps } from "../router.js";
import { computerContext } from "../routes/shared.js";
import { acquireBootLease, clearGoneSandbox, computerStatus } from "./computer-control.js";

/** Start the bot's computer, or confirm the running one still answers, and say how it stands. */
export async function bootBotComputer(
  deps: RouterDeps,
  actor: Actor,
  botId: string,
): Promise<ComputerStatus> {
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  if (!bot.computer) throw new IsolationError();
  if (bot.computer.state === "running" && bot.computer.providerRef) {
    try {
      await ensureComputerWorkspaceLayout(
        deps.sandbox,
        await wakeableComputerRef(deps.prisma, bot.computer),
        parseComputerMode(bot.computer.scope),
        bot.id,
        computerContext(actor, bot.id, "boot"),
      );
      scheduleComputerSleep(deps.jobs, bot.computer.id);
      return computerStatus(deps, actor, botId);
    } catch (error) {
      await clearGoneSandbox(deps, bot.computer, error);
    }
  }
  const ctx = computerContext(actor, bot.id, "boot");
  const manualRunId = `boot:${randomUUID()}`;
  const lease = await acquireBootLease(deps.prisma, {
    computerId: bot.computer.id,
    runId: manualRunId,
    botId: bot.id,
  });
  const computerId = bot.computer.id;
  try {
    await getLogger().withContext({ reason: "manual" }, () =>
      provisionComputer(deps, computerId, {
        ...ctx,
        screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
      }),
    );
    scheduleComputerSleep(deps.jobs, computerId);
  } catch (error) {
    // The bot was deleted or moved to another computer while this boot waited.
    if (isRecordNotFound(error)) {
      throw new ClientError("NOT_FOUND", "Computer no longer exists");
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  return computerStatus(deps, actor, botId);
}
