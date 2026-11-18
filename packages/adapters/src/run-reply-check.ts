import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { approvalModeFromPreference, redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import {
  JEV_AUTO_REVIEW_PROVIDER,
  runCheckerJudge,
  SCRIPTED_AUTO_REVIEW_PROVIDER,
} from "./auto-review.js";
import { decisionModel } from "./decision-models.js";
import {
  buildReplyClaimPrompt,
  parseReplyClaimVerdict,
  REPLY_CLAIM_RUBRIC_VERSION,
  replyClaimCorrectionPrompt,
} from "./reply-claim-check.js";
import { checkerLlmOptions, checkerModelAccess } from "./run-auto-review.js";
import type { RunContext } from "./run-context.js";

/**
 * In Auto, the model that reviews this owner's actions also checks the reply that ends their
 * turn: a reply saying work was done that no tool call did goes back to the bot once. A checker
 * that is missing, fails or cannot be read leaves the reply as it is, unchecked.
 */
export function finalReplyReviewer(ctx: RunContext): AgentRunRequest["reviewFinalReply"] {
  const { deps, run, runId, bot, thread, context } = ctx;
  if (!ctx.source.ownerStartedRun || ctx.source.messagingChannelRun) return undefined;
  return async ({ reply, tools }) => {
    if (approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()) !== "auto") return;
    const settings = await ctx.trust.loadApprovalModel();
    const choice = settings.primary ?? settings.backups[0];
    if (
      !choice ||
      choice.provider === JEV_AUTO_REVIEW_PROVIDER ||
      choice.provider === SCRIPTED_AUTO_REVIEW_PROVIDER ||
      decisionModel(choice.provider, choice.modelId)
    )
      return;
    const checker = {
      provider: choice.provider,
      model: choice.modelId,
      thinkingLevel: choice.thinkingLevel,
      credentialId: choice.credentialId,
    };
    const scope = {
      runId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      threadId: thread.id,
    };
    const access = await checkerModelAccess(
      deps,
      scope,
      {
        memberChecker: settings.primarySource === "member",
        backups: settings.backups,
        registerSecrets: (values) => ctx.secrets.push(...values),
      },
      checker,
    );
    const judged = await runCheckerJudge({
      ...checkerLlmOptions(deps, scope, checker, access),
      prompt: buildReplyClaimPrompt({
        reply: redactSecrets(reply, ctx.secrets),
        tools: tools.map((tool) => ({ ...tool, result: redactSecrets(tool.result, ctx.secrets) })),
      }),
      signal: context.signal,
      operation: "reply-check",
      parse: parseReplyClaimVerdict,
    });
    getLogger().info("agent.reply.checked", {
      "run.id": runId,
      "space.id": run.spaceId,
      "bot.id": bot.id,
      rubric: REPLY_CLAIM_RUBRIC_VERSION,
      model: judged.model,
      verdict: "error" in judged ? "unchecked" : judged.value.verdict,
    });
    if ("error" in judged || judged.value.verdict === "supported") return;
    return replyClaimCorrectionPrompt(judged.value.claim);
  };
}
