/** Limits for a bot's ask_user question, shared by the tool, the answer path and every surface. */
export const ASK_USER_QUESTION_MAX_LENGTH = 240;
export const ASK_USER_OPTION_MAX_LENGTH = 80;
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;
/** A multi-select list reads well a little longer, since nothing is chosen with one tap. */
export const ASK_USER_MAX_MULTIPLE_OPTIONS = 6;
/** The longest draft a bot can show for approval, and the longest edit a person can send back. */
export const ASK_USER_PREVIEW_MAX_LENGTH = 4000;
export const ASK_USER_OTHER_MAX_LENGTH = 500;
/** Images a draft carries, such as a post's pictures, shown with it on the card. */
export const ASK_USER_MAX_IMAGES = 4;
/** Where a draft goes, each with its own character limit, such as several social accounts. */
export const ASK_USER_MAX_LIMITS = 4;
export const ASK_USER_LIMIT_LABEL_MAX_LENGTH = 24;

/** Characters as people count them, so an emoji is one, not two. */
export function askTextLength(text: string): number {
  return [...text].length;
}

/**
 * A card's answer to a choice question: the chosen option ids, the person's own typed answer, and
 * the draft as they edited it.
 */
export type AskChoiceAnswer = { choices: string[]; other?: string; edited?: string };

const ANSWER_KEYS = new Set(["choices", "other", "edited"]);

/**
 * The `answer` string a card sends. A single plain choice stays the bare id every server accepts;
 * anything richer goes as one JSON object, so the card's typed answer is told apart from a reply
 * typed in the composer.
 */
export function encodeAskChoiceAnswer(answer: AskChoiceAnswer): string {
  const { choices, other, edited } = answer;
  if (edited === undefined && other === undefined && choices.length === 1) return choices[0]!;
  return JSON.stringify({
    choices,
    ...(other !== undefined ? { other } : {}),
    ...(edited !== undefined ? { edited } : {}),
  });
}

/** The structured answer a card sent, or undefined for a bare id, label or typed reply. */
export function parseAskChoiceAnswer(answer: string): AskChoiceAnswer | undefined {
  if (!answer.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ANSWER_KEYS.has(key))) return undefined;
  const { choices, other, edited } = record;
  if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string"))
    return undefined;
  if (other !== undefined && typeof other !== "string") return undefined;
  if (edited !== undefined && typeof edited !== "string") return undefined;
  return {
    choices: choices as string[],
    ...(other !== undefined ? { other } : {}),
    ...(edited !== undefined ? { edited } : {}),
  };
}
