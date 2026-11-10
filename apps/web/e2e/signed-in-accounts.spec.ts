import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("adds a second account, switches back and logs out one account at a time", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const password = "password12";
  const first = { email: `accounts-first-${stamp}@rakazo.test`, name: "First Account" };
  const second = { email: `accounts-second-${stamp}@rakazo.test`, name: "Second Account" };
  const menu = (name: string) => page.getByRole("button", { name: `Account menu for ${name}` });

  await signup(page, first.email, password, first.name);
  await completeOnboarding(page);

  await menu(first.name).click();
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cancel" })).toBeVisible();
  await page.getByPlaceholder("Your name").fill(second.name);
  await page.getByPlaceholder("Your email address").fill(second.email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await completeOnboarding(page);

  await menu(second.name).click();
  const firstRow = page.getByTestId("switch-account").filter({ hasText: first.email });
  await expect(firstRow).toBeVisible();
  await captureScreenshot(page, testInfo, "account-switcher");
  await firstRow.click();
  await expect(menu(first.name)).toBeVisible();

  // Logging out ends only the open account; the other one takes its place.
  await menu(first.name).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(menu(second.name)).toBeVisible();
  await menu(second.name).click();
  await expect(page.getByTestId("switch-account")).toHaveCount(0);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
});
