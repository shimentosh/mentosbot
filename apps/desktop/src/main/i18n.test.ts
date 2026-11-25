import { describe, expect, it } from "vitest";
import { errorDetail, isLanguageTag, t, withDetail } from "./i18n.js";

describe("desktop text", () => {
  it("is English and fills in placeholders", () => {
    expect(t("About {name}", { name: "Rakazo" })).toBe("About Rakazo");
    expect(t("Check for Updates…")).toBe("Check for Updates…");
  });

  it("keeps error messages for reports and shows their detail", () => {
    const error = withDetail(new Error("Page failed to load."), t("Page failed to load."));
    expect(error.message).toBe("Page failed to load.");
    expect(errorDetail(error)).toBe("Page failed to load.");
    expect(errorDetail(new Error("plain"))).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
  });

  it("accepts only language tags", () => {
    expect(isLanguageTag("es-CL")).toBe(true);
    expect(isLanguageTag("not a tag")).toBe(false);
    expect(isLanguageTag(42)).toBe(false);
  });
});
