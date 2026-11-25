import { BOT_TEMPLATES } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { botTemplateCopy } from "./bot-template-copy";

describe("botTemplateCopy", () => {
  it("matches the server's English for every template", () => {
    for (const template of BOT_TEMPLATES) {
      expect(botTemplateCopy(template)).toEqual({
        name: template.name,
        summary: template.summary,
        sample: template.sample,
      });
    }
  });

  it("shows the server's English for a template it does not know", () => {
    const template = { ...BOT_TEMPLATES[0]!, id: "new-template", name: "New", summary: "S" };
    expect(botTemplateCopy(template)).toMatchObject({ name: "New", summary: "S" });
  });
});
