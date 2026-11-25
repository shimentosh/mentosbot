import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { AskForDecision } from "./decision-ask.js";
import { askDecisionEligible, decideAskForOwner } from "./decision-ask.js";
import { decisionModel, decisionProviderOf } from "./decision-models.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import { effectiveModelRole } from "./model-roles.js";
import { checkerModelAccess } from "./run-auto-review.js";
import type { RunContext } from "./run-context.js";
import { isStrategicInitiativeRun } from "./strategic-initiative.js";

/**
 * The option the run owner's decision model picks for a question their bot asked, or null to
 * leave it to them. Questions about the owner themselves (the creation intro, daily check-ins)
 * always stay theirs.
 */
export async function decideAskForRunOwner(
  ctx: RunContext,
  ask: AskForDecision,
): Promise<string | null> {
  const { deps, run, runId, bot, thread, context } = ctx;
  if (!askDecisionEligible(ask) || run.trigger === "created" || isStrategicInitiativeRun(run))
    return null;
  try {
    const settings = await effectiveModelRole(
      deps.prisma,
      { userId: run.userId, spaceId: run.spaceId },
      "decision",
      {},
    );
    const choice = settings.primary;
    if (!choice || !decisionModel(choice.provider, choice.modelId)) return null;
    const scope = {
      runId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      threadId: thread.id,
    };
    const { judgeKey, onUsage } = await checkerModelAccess(
      deps,
      scope,
      {
        memberChecker: true,
        backups: settings.backups,
        registerSecrets: (values) => ctx.secrets.push(...values),
      },
      { provider: choice.provider, model: choice.modelId, credentialId: choice.credentialId },
    );
    if (!judgeKey.apiKey) return null;
    const provider = new HttpDecisionProvider(decisionProviderOf(choice.provider), {
      apiKey: judgeKey.apiKey,
      callObserver: judgeKey.callObserver,
      onUsage,
    });
    return await decideAskForOwner(
      provider,
      choice.modelId,
      {
        ask,
        ownerRequest: redactSecrets(ctx.task.prompt, ctx.secrets),
        bot: redactSecrets(`${bot.name}\n${bot.description ?? ""}`, ctx.secrets),
      },
      {
        operationId: `ask-decision:${runId}`,
        traceId: `ask-decision:${runId}`,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        runId,
        signal: context.signal,
      },
    );
  } catch (error) {
    // The owner still gets the question; a missing or failing model never blocks it.
    getLogger().warn("ask decision", { failure: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
