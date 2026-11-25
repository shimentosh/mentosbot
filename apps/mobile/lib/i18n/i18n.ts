import { i18n } from "@lingui/core";
import { translate } from "@rakazo/core";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useSyncExternalStore } from "react";
import { installPluralRules } from "./plural-rules";

/** The app is English only. */
export type UiLocale = "en";

installPluralRules();
i18n.load({ en });
i18n.activate("en");

const NO_TRANSLATIONS: Record<string, string> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveUiLocale(): UiLocale {
  return "en";
}

type DeviceDateFormat = { region: string | null; hourCycle: "h12" | "h23" | null };

const NO_DEVICE_DATE_FORMAT: DeviceDateFormat = { region: null, hourCycle: null };
let deviceDateFormat = NO_DEVICE_DATE_FORMAT;

/**
 * The locale dates, times and numbers are formatted in: English written the way the phone's
 * region writes it, on the phone's 12- or 24-hour clock (`en-GB-u-hc-h23`).
 */
export function dateLocaleForUi(_locale?: UiLocale): string {
  const { region, hourCycle } = deviceDateFormat;
  const base = region ? `en-${region}` : "en-US";
  return hourCycle ? `${base}-u-hc-${hourCycle}` : base;
}

export function useDateLocale(): string {
  return useSyncExternalStore(subscribeI18n, dateLocaleForUi, dateLocaleForUi);
}

export async function refreshDeviceDateFormat(): Promise<void> {
  const format = await bestEffort(
    "read device date format",
    import("expo-localization").then(({ getLocales, getCalendars }): DeviceDateFormat => {
      const region = getLocales()[0]?.regionCode;
      const uses24hourClock = getCalendars()[0]?.uses24hourClock;
      return {
        region: region && /^([A-Z]{2}|\d{3})$/.test(region) ? region : null,
        hourCycle: uses24hourClock === true ? "h23" : uses24hourClock === false ? "h12" : null,
      };
    }),
  );
  if (format) updateDeviceDateFormat(format);
}

function updateDeviceDateFormat(format: DeviceDateFormat): void {
  if (format.region === deviceDateFormat.region && format.hourCycle === deviceDateFormat.hourCycle)
    return;
  deviceDateFormat = format;
  emit();
}

/** Test-only: set the phone's date preferences without native modules. */
export function setDeviceDateFormatForTests(format: Partial<DeviceDateFormat>): void {
  updateDeviceDateFormat({ ...NO_DEVICE_DATE_FORMAT, ...format });
}

/** The app language. Strings come from Lingui's `useLingui`. */
export function useUiLocale(): UiLocale {
  return "en";
}

/** English text with `{name}` placeholders filled in, for screens not on Lingui yet. */
export function t(message: string, values?: Record<string, string | number>): string {
  return translate(NO_TRANSLATIONS, message, values);
}

export function useI18n(): { locale: UiLocale; t: typeof t } {
  return { locale: "en", t };
}

/** Puts English and the default date format back for a test; the app has no other language. */
export function resetI18nForTests(_locale: UiLocale = "en"): void {
  deviceDateFormat = NO_DEVICE_DATE_FORMAT;
  i18n.activate("en");
  emit();
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
  await refreshDeviceDateFormat();
  await applyDirection();
  return "en";
}
