import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";

function approvals(page: Page) {
  return page.getByTestId("approvals");
}

/** Activity rows sit in the approvals window's side column; match their aria-label. */
function activityRow(page: Page, botName: string) {
  return approvals(page)
    .locator("aside")
    .getByRole("button", { name: new RegExp(`^${botName}, `) });
}

async function openApprovals(page: Page) {
  await page.getByTestId("approvals-trigger").click();
  await expect(approvals(page)).toBeVisible();
}

test("approvals show active and finished runs beside what waits on the person", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `activity-${stamp}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await openApprovals(page);
  const activity = approvals(page).locator("aside");
  await expect(approvals(page).getByText("All caught up", { exact: true })).toBeVisible();
  await expect(activity.getByRole("status", { name: "Loading activity…" })).toBeHidden({
    timeout: 20_000,
  });
  await expect(activityRow(page, "Chief")).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toContainText(/keep working|Running|Queued|Starting/i);
  await captureScreenshot(page, testInfo, "58-approvals-activity");

  const runSearch = activity.getByRole("textbox", { name: "Search runs", exact: true });
  await runSearch.fill("keep working");
  await expect(activityRow(page, "Chief")).toBeVisible();
  await runSearch.fill("no-such-run");
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await expect(activity.getByText("No runs match these filters.")).toBeVisible();
  await runSearch.fill("");
  await expect(activityRow(page, "Chief")).toBeVisible();

  const filtersButton = activity.getByRole("button", { name: "Filters", exact: true });
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  await filtersButton.click();
  await expect(filtersButton).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("activity-status-filter").selectOption("failed");
  await expect(activity.getByTestId("activity-filter-indicator")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await page.getByTestId("activity-reset-filters").click();
  await expect(activity.getByTestId("activity-filter-indicator")).toHaveCount(0);
  await expect(activityRow(page, "Chief")).toBeVisible();

  // Opening a run's chat closes the window.
  await activityRow(page, "Chief").click();
  await expect(approvals(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  await openApprovals(page);
  await expect(activity.getByText("Recent", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(activityRow(page, "Chief")).toContainText(/Cancelled|keep working/i);
  // The window opens fresh, with its filters folded.
  await expect(filtersButton).toHaveAttribute("aria-expanded", "false");
  await filtersButton.click();
  await page.getByTestId("activity-date-from").fill("2999-01-01");
  await expect(activity.getByText("No runs match these filters.")).toBeVisible();
  await page.getByTestId("activity-reset-filters").click();
  await expect(activityRow(page, "Chief")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(approvals(page)).toHaveCount(0);
});

test("activity filters keep retry when a refresh fails", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `activity-retry-${stamp}@rakazo.test`, "password12", "Activity");
  await completeOnboarding(page);
  const now = new Date();

  type Phase = "ok" | "empty" | "fail" | "hang";
  let phase: Phase = "ok";
  let releaseHang: (() => void) | null = null;
  let hang: Promise<void> | null = null;
  let released = false;
  const run = {
    runId: "run-filter",
    botId: "bot-filter",
    botName: "Chief",
    groupId: null,
    groupName: null,
    threadId: "thread-filter",
    status: "completed",
    trigger: "user",
    notificationsEnabled: false,
    agentMessage: null,
    promptSnippet: "filter me",
    updatedAt: new Date(now.getTime() - 45_000).toISOString(),
  };

  const agentRun = {
    ...run,
    runId: "run-agent",
    botId: "bot-agent",
    botName: "Helper",
    trigger: "bot_message",
    agentMessage: { fromBotName: "Scout", kind: "update", text: "filter me" },
    promptSnippet: "Update from Scout: filter me",
  };

  await page.route("**/rpc/runs/list", async (route) => {
    if (phase === "hang" && !released) {
      hang ??= new Promise((resolve) => {
        releaseHang = () => {
          released = true;
          phase = "empty";
          resolve();
        };
      });
      await hang;
    }
    if (phase === "fail") {
      await route.fulfill({ status: 500, body: "activity unavailable" });
      return;
    }
    const body = route.request().postDataJSON() as { json?: { filter?: string } } | null;
    const runs = phase === "ok" && body?.json?.filter === "recent" ? [run, agentRun] : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { runs } }),
    });
  });

  // The list refreshes every 15s; drive that poll with a controlled clock.
  await page.clock.install();
  await page.clock.setFixedTime(now);
  await page.reload();
  await openApprovals(page);
  const aside = approvals(page).locator("aside");
  await expect(activityRow(page, "Chief")).toBeVisible({ timeout: 20_000 });

  await expect(activityRow(page, "Chief")).toContainText("filter me");
  await expect(activityRow(page, "Chief").getByText("just now", { exact: true })).toBeVisible();
  await expect(activityRow(page, "Helper")).toContainText("Update from Scout: filter me");
  await captureScreenshot(page, testInfo, "61a-activity-first-minute");
  const activitySearch = aside.getByRole("textbox", { name: "Search runs", exact: true });
  await activitySearch.fill("Update from Scout");
  await expect(activityRow(page, "Helper")).toBeVisible();
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await activitySearch.fill("Chief");

  phase = "empty";
  await page.clock.fastForward(15_000);
  await expect(activityRow(page, "Chief")).toHaveCount(0);
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");

  phase = "fail";
  await page.clock.fastForward(15_000);
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");

  phase = "hang";
  await retry.click();
  await expect(aside.getByRole("status", { name: "Loading activity…" })).toBeVisible();
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect.poll(() => releaseHang !== null).toBe(true);
  releaseHang?.();
  await expect(aside.getByRole("status", { name: "Loading activity…" })).toBeHidden({
    timeout: 20_000,
  });
  await expect(retry).toHaveCount(0);
  await expect(aside.getByText("No runs match these filters.")).toHaveCount(0);
  await expect(activitySearch).toHaveValue("Chief");
});

test("approvals hold questions as cards and group work and unread chats beside them", async ({
  page,
}, testInfo) => {
  await signup(page, `activity-sections-${Date.now()}@rakazo.test`, "password12", "Sections");
  await completeOnboarding(page);
  const writer = await createNamedBot(page, "Writer");
  await expect
    .poll(async () => {
      const active = await rpc<{ runs: Array<{ botId: string }> }>(page, "runs/list", {
        filter: "active",
      });
      return active.runs.some((run) => run.botId === writer);
    })
    .toBe(false);
  await createNamedBot(page, "Head of Marketing");
  await rpc(page, "threads/markUnread", { botId: writer });
  await page.getByPlaceholder("Message Head of Marketing").fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Which city should I use?", { exact: true })).toBeVisible();
  const researcher = await createNamedBot(page, "Researcher");
  await page.getByPlaceholder("Message Researcher").fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await openApprovals(page);

  const aside = approvals(page).locator("aside");
  const working = aside.getByRole("region", { name: "Working", exact: true });
  const unread = aside.getByRole("region", { name: "Unread", exact: true });
  // The question waits as a card to answer here, not as an activity row.
  const waiting = approvals(page).getByTestId("approval");
  await expect(waiting.filter({ hasText: "Head of Marketing" })).toContainText(
    "Which city should I use?",
    { timeout: 20_000 },
  );
  await expect(aside.getByRole("button", { name: /^Head of Marketing,/ })).toHaveCount(0);
  await expect(working.getByRole("button", { name: /^Researcher,/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(unread.getByRole("button", { name: /^Unread/ })).toBeVisible();
  await unread.getByRole("button", { name: /^Unread/ }).click();
  await expect(unread).toContainText("Writer");
  await captureScreenshot(page, testInfo, "61b-approvals-sections");
  await rpc(page, "threads/stop", { botId: researcher });
});
