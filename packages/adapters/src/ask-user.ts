import {
  ASK_USER_LIMIT_LABEL_MAX_LENGTH,
  ASK_USER_MAX_IMAGES,
  ASK_USER_MAX_LIMITS,
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
  previewLimits?: Array<{ label: string; max: number }>;
  previewImages?: string[];
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
  const limits = previewLimits(args.limits, preview);
  const images = previewImages(args.images, preview);
  const limit = args.limit ?? (limits ? Math.min(...limits.map((entry) => entry.max)) : undefined);
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
    ...(limits ? { previewLimits: limits } : {}),
    ...(images ? { previewImages: images } : {}),
    ...(multiple ? { multiple: true as const } : {}),
    ...(args.other === true ? { other: true as const } : {}),
  };
}

const LIMIT_ERROR = `ask_user limits is a list of up to ${ASK_USER_MAX_LIMITS} { label, max } entries, label at most ${ASK_USER_LIMIT_LABEL_MAX_LENGTH} characters and max a whole number from 1 to ${ASK_USER_PREVIEW_MAX_LENGTH}`;

/** Each place the draft goes with its own limit; a draft over any of them goes back to the model. */
function previewLimits(value: unknown, preview: unknown) {
  if (value === undefined || value === null) return undefined;
  if (preview === undefined) throw new Error("ask_user limits needs a preview");
  if (!Array.isArray(value) || value.length === 0 || value.length > ASK_USER_MAX_LIMITS)
    throw new Error(LIMIT_ERROR);
  const limits = value.map((entry) => {
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const max = entry?.max;
    if (
      !label ||
      label.length > ASK_USER_LIMIT_LABEL_MAX_LENGTH ||
      typeof max !== "number" ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > ASK_USER_PREVIEW_MAX_LENGTH
    )
      throw new Error(LIMIT_ERROR);
    return { label, max };
  });
  const length = askTextLength(String(preview));
  const over = limits.filter((entry) => length > entry.max);
  if (over.length)
    throw new Error(
      `ask_user preview is ${length} characters, over ${over.map((entry) => `${entry.label} (${entry.max})`).join(", ")}; shorten it, or ask separately for each, and ask again`,
    );
  return limits;
}

/** Artifact ids of the images that go with the draft, as attach_file or generate_image returned them. */
function previewImages(value: unknown, preview: unknown) {
  if (value === undefined || value === null) return undefined;
  if (preview === undefined) throw new Error("ask_user images needs a preview");
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ASK_USER_MAX_IMAGES ||
    value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
  )
    throw new Error(
      `ask_user images is a list of up to ${ASK_USER_MAX_IMAGES} artifact ids from attach_file or generate_image`,
    );
  return [...new Set(value as string[])];
}
