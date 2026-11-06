import { translate } from "@rakazo/core";

/** The app is English only. */
export type UiLocale = "en";

const NO_TRANSLATIONS: Record<string, string> = {};

export function getActiveUiLocale(): UiLocale {
  return "en";
}

/** Dates and numbers read the English way everywhere. */
export function dateLocaleForUi(_locale?: UiLocale): string {
  return "en-US";
}

/** English text with `{name}` placeholders filled in. */
export function t(message: string, values?: Record<string, string | number>): string {
  return translate(NO_TRANSLATIONS, message, values);
}

export function useI18n(): { locale: UiLocale; t: typeof t } {
  return { locale: "en", t };
}

async function applyDirection(): Promise<void> {
  try {
    // English lays out left to right; never follow the device's direction, which would fight
    // this and reload-loop on right-to-left phones.
    const { applyMobileUiDirection } = await import("./ui-direction");
    applyMobileUiDirection("en");
  } catch {
    // Tests and some hosts have no native direction APIs.
  }
}

/** The device's preferred language (`es-CL`), from Expo where it loads, else from Intl. */
export async function deviceLanguage(): Promise<string | null> {
  // Lazy: nearly every module imports i18n, including ones evaluated without native modules.
  try {
    const localization = await import("expo-localization");
    const tag = localization.getLocales()[0]?.languageTag;
    if (typeof tag === "string" && tag) return tag;
  } catch {
    // Keep Intl fallback.
  }
  try {
    const IntlRef = globalThis.Intl;
    return IntlRef?.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

export async function bootstrapI18n(): Promise<UiLocale> {
  await applyDirection();
  return "en";
}

/** "Messaged Ana", "Message from Ana", or "3 messages with Ana". */
export function peerExchangeLabel(
  count: number,
  direction: "sent" | "received",
  peer: string,
): string {
  if (count === 1)
    return direction === "sent"
      ? t("Messaged {peer}", { peer })
      : t("Message from {peer}", { peer });
  return t("{count} messages with {peer}", { count, peer });
}
