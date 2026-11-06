import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const resources = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modules/rakazo-notifications/android/src/main/res",
);
const keys = [
  "rakazo_channel_live",
  "rakazo_channel_messages",
  "rakazo_channel_scheduled",
  "rakazo_channel_attention",
  "rakazo_live_one",
  "rakazo_live_many",
  "rakazo_live_working",
  "rakazo_scheduled_title",
  "rakazo_replied_group",
  "rakazo_replied",
  "rakazo_attention_failed",
  "rakazo_attention_takeover",
  "rakazo_attention_input",
];

const xml = () => readFileSync(resolve(resources, "values", "strings.xml"), "utf8");

describe("Android notification resources", () => {
  it("provides every notification string", () => {
    const strings = xml();
    for (const key of keys) expect(strings).toContain(`name="${key}"`);
  });
});
