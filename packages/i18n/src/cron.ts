import { t } from "@lingui/core/macro";
import type { CronLabels, CronUnit } from "@rakazo/core";
import { ENGLISH_CRON_LABELS } from "@rakazo/core";

export function cronUnitLabel(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t`minutes`;
    case "hours":
      return t`hours`;
    case "days":
      return t`days`;
    default:
      return unit;
  }
}

/**
 * Schedule words for `formatCron`: routine rows, the status line, the `@` picker.
 * The app is English only, so every locale reads the English labels.
 */
export function cronLabels(_locale?: string): CronLabels {
  return ENGLISH_CRON_LABELS;
}
