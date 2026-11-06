import { i18n } from "@lingui/core";
import { importChunk } from "./preload-recovery";

export { i18n };

type CatalogModule = { messages: Parameters<typeof i18n.load>[1] };

/** The app is English only: load its one catalog, or run on the source text if that fails. */
export async function bootstrapI18n(): Promise<void> {
  if (i18n.locale === "en") return;
  try {
    const { messages } = await importChunk(
      () => import("../locales/en/messages.po") as Promise<CatalogModule>,
    );
    i18n.load("en", messages);
  } catch {
    i18n.load("en", {});
  }
  i18n.activate("en");
}
