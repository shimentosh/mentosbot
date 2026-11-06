import { i18n } from "@lingui/core";
import { t as translate } from "@lingui/core/macro";
import { fileSizeParts } from "@rakazo/core";

/** A byte count in the reader's locale, such as "1.5 GB". */
export function formatSize(bytes: number): string {
  const parts = fileSizeParts(bytes, i18n.locale || "en");
  if (!parts) return "";
  const size = parts.amount;
  switch (parts.unit) {
    case "B":
      return translate`${size} B`;
    case "KB":
      return translate`${parts.amount} KB`;
    case "MB":
      return translate`${parts.amount} MB`;
    case "GB":
      return translate`${parts.amount} GB`;
    case "TB":
      return translate`${parts.amount} TB`;
  }
}
