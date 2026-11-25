import type { AdapterContext, DecisionProvider } from "@rakazo/adapter-kit";

export const ASK_DECISION_RUBRIC_VERSION = "ask-answer-v1";
/** The choice that leaves the question to the owner. */
const OWNER_DECIDES = "owner_decides";
/** The least probability an option needs before it is chosen for the owner. */
export const ASK_DECISION_MIN_PROBABILITY = 0.8;
const ASK_DECISION_TIMEOUT_MS = 10_000;
const MAX_TASK_CHARS = 4_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_BOT_CHARS = 400;

const INSTRUCTIONS =
  "A bot paused its work to ask its owner this question. Pick the option the owner's request " +
  "and the bot's own question already settle, so the work can go on without waiting. Pick " +
  `"${OWNER_DECIDES}" whenever they do not clearly settle it.`;
const OWNER_DECIDES_CRITERION =
  "Only the owner can answer: the request does not settle it, it is a matter of the owner's " +
  "taste or opinion, or picking wrongly would spend money, send or publish something, delete " +
  "or change data, or be hard to undo.";

export type AskForDecision = {
  text: string;
  detail?: string;
  actions?: ReadonlyArray<{ id: string; label: string }>;
  preview?: string;
  previewImages?: readonly string[];
  multiple?: true;
};

/** Only a plain one-of-several question can be answered for the owner; a draft is theirs to approve. */
export function askDecisionEligible(ask: AskForDecision): boolean {
  return (
    (ask.actions?.length ?? 0) >= 2 &&
    !ask.multiple &&
    ask.preview === undefined &&
    !ask.previewImages?.length
  );
}

const clip = (text: string | undefined, max: number) =>
  text && text.length > max ? `${text.slice(0, max)}…` : (text ?? "");

/**
 * The option the decision model is sure the owner's own words settle, or null to leave the
 * question to the owner. Any failure leaves it to them too.
 */
export async function decideAskForOwner(
  provider: DecisionProvider,
  model: string,
  input: { ask: AskForDecision; ownerRequest: string; bot: string },
  context: AdapterContext,
): Promise<string | null> {
  const { ask } = input;
  if (!askDecisionEligible(ask)) return null;
  const actions = ask.actions ?? [];
  const criteria: Record<string, string> = {};
  for (const action of actions) criteria[action.id] = action.label;
  if (Object.hasOwn(criteria, OWNER_DECIDES)) return null;
  criteria[OWNER_DECIDES] = OWNER_DECIDES_CRITERION;
  try {
    const result = await provider.decide(
      {
        model,
        state: {
          rubricVersion: ASK_DECISION_RUBRIC_VERSION,
          ownerRequest: clip(input.ownerRequest, MAX_TASK_CHARS),
          bot: clip(input.bot, MAX_BOT_CHARS),
          question: clip(ask.text, MAX_TEXT_CHARS),
          ...(ask.detail ? { detail: clip(ask.detail, MAX_TEXT_CHARS) } : {}),
          options: actions.map((action) => ({ id: action.id, label: action.label })),
        },
        questions: { answer: { type: "choice", instructions: INSTRUCTIONS, criteria } },
      },
      {
        ...context,
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(ASK_DECISION_TIMEOUT_MS)]),
      },
    );
    const answer = result.answers.answer;
    if (!answer || answer.choice === OWNER_DECIDES) return null;
    if (!actions.some((action) => action.id === answer.choice)) return null;
    const probability = answer.probabilities?.[answer.choice] ?? answer.confidence;
    if (typeof probability !== "number" || probability < ASK_DECISION_MIN_PROBABILITY) return null;
    return answer.choice;
  } catch {
    return null;
  }
}
