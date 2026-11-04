import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

async function asAdmin(route: Route) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = (body.json?.me ?? body.json) as Record<string, unknown> | undefined;
  if (me) me.isAdmin = true;
  await route.fulfill({ response, json: body });
}

const none = {
  source: "none",
  active: true,
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  hasSecret: false,
};

test("an admin connects a bucket for bot files", async ({ page }, testInfo) => {
  await signup(page, `storage-settings-${randomUUID()}@rakazo.test`, "password12", "Storage");
  await completeOnboarding(page);
  await page.route("**/rpc/me", asAdmin);
  await page.route("**/rpc/bootstrap", asAdmin);
  const saved = {
    ...none,
    // The server keeps running on local disk until it restarts onto the bucket.
    active: false,
    source: "settings",
    endpoint: "https://storage.example.com",
    bucket: "rakazo-files",
    region: "us-east-1",
    accessKeyId: "example-key-id",
    hasSecret: true,
  };
  let current: Record<string, unknown> = none;
  await page.route(/\/rpc\/objectStorage\/get(\?|$)/, (route) =>
    route.fulfill({ json: { json: current } }),
  );
  let sent: Record<string, unknown> | undefined;
  await page.route(/\/rpc\/objectStorage\/update(\?|$)/, async (route) => {
    sent = (route.request().postDataJSON() as { json: Record<string, unknown> }).json;
    current = saved;
    await route.fulfill({ json: { json: saved } });
  });
  await page.reload();
  const settings = await openUserSettings(page, "storage");
  const form = settings.getByTestId("storage-settings");
  await form.getByLabel("Endpoint").fill("https://storage.example.com");
  await form.getByLabel("Bucket", { exact: true }).fill("rakazo-files");
  await form.getByLabel("Access key ID").fill("example-key-id");
  await form.getByLabel("Secret access key").fill("example-secret");
  await expect(form.getByLabel("Secret access key")).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "storage-settings");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText("Switching storage…")).toBeVisible();
  expect(sent).toMatchObject({ bucket: "rakazo-files", secretAccessKey: "example-secret" });
  await expect(form.getByLabel("Bucket", { exact: true })).toBeDisabled();
});
