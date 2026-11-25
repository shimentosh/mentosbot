import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { AskForDecision } from "../../approvals/decision-ask.js";
import { askDecisionEligible, decideAskForOwner } from "../../approvals/decision-ask.js";
import { decisionModel } from "../../approvals/decision-models.js";
import { effectiveModelRole } from "../../models/model-roles.js";
import { isStrategicInitiativeRun } from "../../routines/strategic-initiative.js";
import type { RunContext } from "../assembly/run-context.js";
import { checkerModelAccess } from "./run-auto-review.js";

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
    const decision = choice ? decisionModel(choice.provider, choice.modelId) : undefined;
    if (!choice || !decision) return null;
    // Only the owner's own words can settle a choice for them, never a bot's, a webhook's or a
    // tool result's.
    const ownerRequest = (await ctx.trust.loadOwnerWords()).trim();
    if (!ownerRequest) return null;
    const operationId = `ask-decision:${runId}`;
    const { judgeKey, onUsage } = await checkerModelAccess(
      deps,
      {
        runId,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        threadId: thread.id,
        operationId,
      },
      { memberChecker: true, registerSecrets: (values) => ctx.secrets.push(...values) },
      { provider: choice.provider, model: choice.modelId, credentialId: choice.credentialId },
    );
    if (!judgeKey.apiKey) return null;
    // A connection that keeps no prompts is never sent to a host that cannot promise it.
    if (judgeKey.zeroDataRetention && !decision.dataRetentionControl) return null;
    const provider = decision.create({
      apiKey: judgeKey.apiKey,
      ...(judgeKey.zeroDataRetention ? { zeroDataRetention: true } : {}),
      callObserver: judgeKey.callObserver,
      onUsage,
    });
    return await decideAskForOwner(
      provider,
      choice.modelId,
      {
        ask,
        ownerRequest: redactSecrets(ownerRequest, ctx.secrets),
        bot: redactSecrets(`${bot.name}\n${bot.description ?? ""}`, ctx.secrets),
      },
      {
        operationId,
        traceId: operationId,
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
