import type { CronLabels } from "@rakazo/core";
import { ENGLISH_CRON_LABELS } from "@rakazo/core";

/** Schedule words for `formatCron`: routine rows, the status line, the `@` picker. */
export function cronLabels(): CronLabels {
  return ENGLISH_CRON_LABELS;
}
