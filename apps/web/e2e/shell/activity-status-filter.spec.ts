import { expect, test } from "@playwright/test";
import { captureScreenshot, chooseOption, completeOnboarding, signup } from "../helpers/helpers";

test("approvals activity can find a failure before the same chat's latest success", async ({
  page,
}, testInfo) => {
  await signup(page, `activity-status-${Date.now()}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);
  const composer = page.getByPlaceholder("Message Chief");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const earlier = "Which checks could fail this run?";
  const later = "Summarize the launch notes";
  await composer.fill(earlier);
  await send.click();
  await expect(page.getByTestId("composer-error")).toBeVisible();
  await page.getByTestId("composer-error-dismiss").click();
  await composer.fill(later);
  await send.click();

  // Activity sits in the approvals window's side column.
  await page.getByTestId("approvals-trigger").click();
  const aside = page.getByTestId("approvals").locator("aside");
  const success = aside.getByRole("button", { name: "Chief, Done", exact: true });
  await expect(success).toContainText(later);
  await aside.getByRole("button", { name: "Filters", exact: true }).click();
  await chooseOption(page.getByTestId("activity-status-filter"), "Failed");
  await expect(aside.getByRole("button", { name: "Chief, Failed", exact: true })).toContainText(
    earlier,
  );
  await expect(success).toHaveCount(0);
  await captureScreenshot(page, testInfo, "61c-activity-older-failure");
});
