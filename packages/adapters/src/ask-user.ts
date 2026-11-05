import {
  ASK_USER_MAX_MULTIPLE_OPTIONS,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_OPTION_MAX_LENGTH,
  ASK_USER_PREVIEW_MAX_LENGTH,
  ASK_USER_QUESTION_MAX_LENGTH,
  askTextLength,
} from "@rakazo/contracts";

/** An ask_user call the card can show, with every limit already checked. */
export type AskUserRequest = {
  question: string;
  options: string[];
  preview?: string;
  previewLimit?: number;
  multiple?: true;
  other?: true;
};

/** Checks an ask_user call strictly, so a bad one fails back to the model instead of the card. */
export function askUserRequest(args: Record<string, unknown>): AskUserRequest {
  const multiple = args.multiple === true;
  const maxOptions = multiple ? ASK_USER_MAX_MULTIPLE_OPTIONS : ASK_USER_MAX_OPTIONS;
  const options = Array.isArray(args.options)
    ? args.options.map((option) => String(option).trim())
    : [];
  if (
    options.length < ASK_USER_MIN_OPTIONS ||
    options.length > maxOptions ||
    options.some((option) => option.length === 0 || option.length > ASK_USER_OPTION_MAX_LENGTH) ||
    new Set(options).size !== options.length
  ) {
    throw new Error(
      multiple
        ? "ask_user with multiple requires two to six unique, non-empty options"
        : "ask_user requires two to four unique, non-empty options",
    );
  }
  const question = String(args.question ?? "What should I use?");
  if (question.length > ASK_USER_QUESTION_MAX_LENGTH) {
    throw new Error(`ask_user question must be at most ${ASK_USER_QUESTION_MAX_LENGTH} characters`);
  }
  for (const flag of ["multiple", "other"] as const) {
    if (args[flag] !== undefined && args[flag] !== null && typeof args[flag] !== "boolean")
      throw new Error(`ask_user ${flag} must be true or false`);
  }
  const preview = args.preview ?? undefined;
  if (
    preview !== undefined &&
    (typeof preview !== "string" || !preview.trim() || preview.length > ASK_USER_PREVIEW_MAX_LENGTH)
  ) {
    throw new Error(
      `ask_user preview must be non-empty text of at most ${ASK_USER_PREVIEW_MAX_LENGTH} characters`,
    );
  }
  const limit = args.limit ?? undefined;
  if (limit !== undefined) {
    if (preview === undefined) throw new Error("ask_user limit needs a preview");
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > ASK_USER_PREVIEW_MAX_LENGTH
    ) {
      throw new Error(
        `ask_user limit must be a whole number from 1 to ${ASK_USER_PREVIEW_MAX_LENGTH}`,
      );
    }
    const length = askTextLength(preview);
    if (length > limit) {
      throw new Error(
        `ask_user preview is ${length} characters, over its limit of ${limit}; shorten it and ask again`,
      );
    }
  }
  return {
    question,
    options,
    ...(preview !== undefined ? { preview } : {}),
    ...(limit !== undefined ? { previewLimit: limit } : {}),
    ...(multiple ? { multiple: true as const } : {}),
    ...(args.other === true ? { other: true as const } : {}),
  };
}
