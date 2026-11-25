import type { AgentRuntimeEvent, AutoReviewProvider } from "@rakazo/adapter-kit";
import { recordUsage } from "@rakazo/db";
import type { AutoReviewChecker, LlmAutoReviewOptions } from "../../approvals/auto-review.js";
import {
  autoReviewTimeoutMs,
  isAutoReviewCheckerConfigured,
  resolveAutoReviewChecker,
  resolveAutoReviewProviderKind,
} from "../../approvals/auto-review.js";
import { createAutoReviewProvider } from "../../approvals/auto-review-factory.js";
import { CheckerConnectionUnavailableError } from "../../approvals/auto-review-failures.js";
import { DecisionAutoReviewProvider } from "../../approvals/decision-auto-review.js";
import { decisionModel } from "../../approvals/decision-models.js";
import { operatorReviewObserver } from "../../approvals/operator-review-usage.js";
import {
  findConnectedModelCredential,
  hasHostedModelCredits,
} from "../../models/model-selection.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { modelCreditBillingEnabled, resolveModelKey } from "./run-model.js";

/**
 * The deployment's operator-funded reviewer, when hosted credits include one. It needs no
 * connection or credits of the member's, so it can still decide when their own choice cannot.
 */
export async function includedAutoReviewChecker(
  deps: Pick<ExecutorDeps, "prisma" | "billingEnabled">,
): Promise<AutoReviewChecker | null> {
  if (!(await modelCreditBillingEnabled(deps))) return null;
  const checker = resolveAutoReviewChecker(process.env, true);
  if (
    !checker ||
    !decisionModel(checker.provider, checker.model) ||
    !isAutoReviewCheckerConfigured({ checker })
  )
    return null;
  return { ...checker, included: true };
}

type CheckerScope = {
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
};
type CheckerAccess = Awaited<ReturnType<typeof checkerModelAccess>>;

/** The Auto Review provider that judges a run's action with one checker choice. */
export async function autoReviewCheckerProvider(
  deps: ExecutorDeps,
  scope: CheckerScope,
  options: {
    injectedReview?: AutoReviewProvider;
    memberChecker: boolean;
    registerSecrets: (values: string[]) => void;
  },
  checker: AutoReviewChecker,
): Promise<AutoReviewProvider> {
  const { runId, spaceId, userId, botId } = scope;
  const { injectedReview, memberChecker, registerSecrets } = options;
  if (injectedReview) return injectedReview;
  const deploymentChoice = !memberChecker && !checker.credentialId && !checker.creditOfferingId;
  const kind =
    memberChecker || (checker.provider !== "jev" && checker.provider !== "scripted")
      ? "llm"
      : resolveAutoReviewProviderKind();
  const decision = decisionModel(checker.provider, checker.model);
  // A checker model that is not a decision model answers in JSON text, on the member's own key.
  if (kind === "llm" && !decision) {
    const access = await checkerModelAccess(deps, scope, options, checker);
    return createAutoReviewProvider("llm", {
      llm: checkerLlmOptions(deps, scope, checker, access),
    });
  }
  const hosted =
    deploymentChoice &&
    (Boolean(decision) || kind === "jev" || kind === "scripted") &&
    (await modelCreditBillingEnabled(deps));
  // Only the included decision checker uses operator auth without a personal connection.
  const included = hosted && Boolean(decision) && isAutoReviewCheckerConfigured({ checker });
  const reviewCredential =
    checker.creditOfferingId || included || kind === "jev" || kind === "scripted"
      ? null
      : await findCheckerCredential(deps, scope, checker);
  const operatorFunded = hosted && !reviewCredential;
  const operatorObserver = operatorFunded
    ? operatorReviewObserver(deps.prisma, {
        spaceId,
        userId,
        botId,
        runId,
        parentRunId: runId,
        operationId: `auto-review:${runId}`,
        operationKind: "setup",
      })
    : undefined;
  const onUsage = checkerUsageRecorder(deps, scope, operatorFunded);
  if (kind === "jev" || kind === "scripted") {
    return createAutoReviewProvider(kind, {
      callObserver: operatorObserver,
      onUsage: operatorFunded ? undefined : onUsage,
    });
  }
  // Every other llm checker is a decision model here; one without returned above.
  if (!decision) throw new CheckerConnectionUnavailableError();
  await requireCheckerConnection(deps, scope, memberChecker, checker, reviewCredential);
  const deploymentKey =
    deploymentChoice && !reviewCredential ? decision.deploymentApiKey(process.env) : undefined;
  if (deploymentKey) registerSecrets([deploymentKey]);
  const judgeKey = deploymentKey
    ? null
    : await resolveModelKey(
        deps,
        userId,
        spaceId,
        reviewCredential,
        checker.provider,
        checker.model,
        registerSecrets,
        {
          creditOfferingId: checker.creditOfferingId,
          requireStoredSecret: Boolean(checker.credentialId),
          operatorFunded,
        },
      );
  return new DecisionAutoReviewProvider({
    provider: decision.create({
      apiKey: deploymentKey ?? judgeKey?.apiKey ?? "",
      callObserver: operatorObserver ?? judgeKey?.callObserver,
      onUsage: operatorFunded ? undefined : onUsage,
    }),
    providerId: checker.provider,
    model: checker.model,
  });
}

function findCheckerCredential(
  deps: ExecutorDeps,
  { userId, spaceId }: CheckerScope,
  checker: AutoReviewChecker,
) {
  return findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    { userId, spaceId },
    checker.provider,
    checker.model,
    { credentialId: checker.credentialId },
  );
}

/** A checker the member chose, or a stored connection named, must still be reachable. */
async function requireCheckerConnection(
  deps: ExecutorDeps,
  { userId, spaceId }: CheckerScope,
  memberChecker: boolean,
  checker: AutoReviewChecker,
  reviewCredential: Awaited<ReturnType<typeof findCheckerCredential>> | null,
) {
  if (
    (memberChecker || checker.credentialId) &&
    !reviewCredential &&
    !checker.creditOfferingId &&
    !(await hasHostedModelCredits(deps.prisma, { userId, spaceId }, checker.provider))
  ) {
    throw new CheckerConnectionUnavailableError();
  }
}

function checkerUsageRecorder(deps: ExecutorDeps, scope: CheckerScope, operatorFunded: boolean) {
  const { runId, spaceId, userId, botId } = scope;
  return (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      spaceId,
      userId,
      botId,
      parentRunId: runId,
      runId,
      operationId: `auto-review:${runId}`,
      operationKind: "setup",
      fundingSource: operatorFunded ? "operator" : "customer",
    });
}

/** The key and usage record a checker model that is not a decision model runs with. */
export async function checkerModelAccess(
  deps: ExecutorDeps,
  scope: CheckerScope,
  options: { memberChecker: boolean; registerSecrets: (values: string[]) => void },
  checker: AutoReviewChecker,
) {
  const { userId, spaceId } = scope;
  const reviewCredential = checker.creditOfferingId
    ? null
    : await findCheckerCredential(deps, scope, checker);
  await requireCheckerConnection(deps, scope, options.memberChecker, checker, reviewCredential);
  const judgeKey = await resolveModelKey(
    deps,
    userId,
    spaceId,
    reviewCredential,
    checker.provider,
    checker.model,
    options.registerSecrets,
    {
      creditOfferingId: checker.creditOfferingId,
      requireStoredSecret: Boolean(checker.credentialId),
      operatorFunded: false,
    },
  );
  return { judgeKey, onUsage: checkerUsageRecorder(deps, scope, false) };
}

/** What the JSON-text checker needs to ask this checker choice one question. */
export function checkerLlmOptions(
  deps: ExecutorDeps,
  scope: CheckerScope,
  checker: AutoReviewChecker,
  { judgeKey, onUsage }: CheckerAccess,
): LlmAutoReviewOptions {
  return {
    onUsage,
    runtime: deps.runtime,
    checker,
    apiKey: judgeKey.oauth ? undefined : judgeKey.apiKey,
    callObserver: judgeKey.callObserver,
    accountId: judgeKey.accountId,
    gatewayId: judgeKey.gatewayId,
    projectId: judgeKey.projectId,
    region: judgeKey.region,
    baseUrl: judgeKey.baseUrl,
    headers: judgeKey.headers,
    allowPrivateEndpoint: judgeKey.allowPrivateEndpoint,
    cacheCapabilities: judgeKey.cacheCapabilities,
    contextWindow: judgeKey.contextWindow,
    maxTokens: judgeKey.maxTokens,
    reasoning: judgeKey.reasoning,
    oauth: judgeKey.oauth
      ? {
          credential: judgeKey.oauth,
          persist: judgeKey.persistOAuth,
          refresh: judgeKey.refreshOAuth,
          retire: judgeKey.retireOAuth,
        }
      : undefined,
    ...scope,
    timeoutMs: autoReviewTimeoutMs(),
  };
}
