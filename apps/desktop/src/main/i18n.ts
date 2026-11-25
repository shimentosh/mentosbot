import { translate } from "@rakazo/core";

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** The desktop is English only; this fills `{name}` placeholders in the English text. */
export function t(message: string, values?: Record<string, string | number>): string {
  return translate({}, message, values);
}

/** An error whose message stays English for error reports and shows `detail` to the person. */
export function withDetail<E extends Error>(error: E, detail: string): E & { detail: string } {
  return Object.assign(error, { detail });
}

/** The text an error carries for the person, if it was given one. */
export function errorDetail(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : undefined;
}

/** Language tags only, such as `es` or `zh-TW`: pages and saved files supply these. */
export function isLanguageTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= 35 && LANGUAGE_TAG.test(value);
}
