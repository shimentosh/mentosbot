import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

type OrganizationList = {
  organizations: Array<{ id: string; role: string; memberCount: number; defaultSpaceId: string }>;
};

type SentEmail = { to: string; subject: string; text: string; html: string };

const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";

/** The newest email to `to` whose subject matches, from the harness's shared outbox. */
async function latestEmail(page: Page, to: string, subject: RegExp): Promise<SentEmail> {
  const matching = async () => {
    const response = await page.request.get(`${emailApi}/__e2e/emails`);
    const messages = (await response.json()) as SentEmail[];
    return messages.filter((message) => message.to === to && subject.test(message.subject));
  };
  await expect.poll(async () => (await matching()).length).toBeGreaterThan(0);
  return (await matching()).at(-1)!;
}

function firstLink(message: SentEmail): string {
  const url = message.text.match(/https?:\/\/\S+/)?.[0];
  expect(url).toBeTruthy();
  return url!;
}

test("invite a teammate, who joins from the emailed link", async ({ page, browser }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `team-owner-${stamp}@rakazo.test`, "password12", "Team Owner");
  await completeOnboarding(page);

  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  const members = settings.getByTestId("team-members");
  await expect(members.getByText("Team Owner")).toBeVisible();
  await members.getByRole("button", { name: "Invite", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Invite to team" });
  const invitee = `team-member-${stamp}@rakazo.test`;
  await dialog.getByLabel("Email").fill(invitee);
  await captureScreenshot(page, testInfo, "team-invite-dialog");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(members.getByText(invitee)).toBeVisible();
  await captureScreenshot(page, testInfo, "team-members");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  const invitation = await latestEmail(page, invitee, /invited you to/);
  const inviteUrl = firstLink(invitation);
  expect(new URL(inviteUrl).pathname).toMatch(/^\/invite\/[\w-]+$/);

  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const teammate = await context.newPage();
    await signup(teammate, invitee, "password12", "Team Member");
    await completeOnboarding(teammate);
    // This server sends email, so joining needs the address proven first.
    const verification = await latestEmail(teammate, invitee, /Verify/);
    await teammate.goto(firstLink(verification));

    await teammate.goto(new URL(inviteUrl).pathname);
    await expect(teammate.getByRole("button", { name: "Join team" })).toBeVisible();
    await expect(
      teammate.getByText("The team's owner can see its chats and activity."),
    ).toBeVisible();
    await captureScreenshot(teammate, testInfo, "team-invite-accept");
    await teammate.getByRole("button", { name: "Join team" }).click();
    await teammate.waitForURL(/\/app/);

    const { organizations } = await rpc<OrganizationList>(teammate, "organizations/list", {});
    const team = organizations.find((organization) => organization.role === "member")!;
    expect(team).toMatchObject({ memberCount: 2 });

    // A bot the teammate makes in the team shows up for the owner, to read.
    const created = await teammate.request.post("/rpc/bots/create", {
      data: {
        json: { name: "Research helper", description: "", instructions: "", notifyOnFinish: false },
      },
      headers: { "x-rakazo-space-id": team.defaultSpaceId },
    });
    expect(created.ok()).toBe(true);
    await page.reload();
    const teamBots = page.getByTestId("team-bots");
    const helper = teamBots.getByRole("button", { name: /Research helper/ });
    await expect(helper).toBeVisible();
    await expect(helper).toContainText("Team Member");
    await captureScreenshot(page, testInfo, "team-bots-sidebar");
    await helper.click();
    const chat = page.getByTestId("team-bot-chat");
    await expect(chat.getByRole("heading", { name: /Research helper/ })).toBeVisible();
    // Reading only: the owner gets no composer for a teammate's bot.
    await expect(chat.getByRole("textbox")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "team-bot-chat");
    // The owner can watch the bot's screen too, and only watch it.
    await chat.getByRole("button", { name: "Screen" }).click();
    await expect(
      chat.getByText("The computer isn't running.").or(chat.locator("iframe")),
    ).toBeVisible();
    await chat.getByRole("button", { name: "Screen" }).click();
    await page.keyboard.press("Escape");

    // The owner shares their own bot with the teammate, from its settings.
    const ownerBotId = activeBotId(page);
    await openBotPanelTab(page, "Advanced");
    const shareSection = page.getByTestId("bot-share");
    await shareSection.getByRole("button", { name: "Share" }).click();
    await page.getByRole("menuitem", { name: "Team Member" }).click();
    await expect(shareSection.getByLabel("Access for Team Member")).toHaveValue("chat");
    await captureScreenshot(page, testInfo, "bot-share-section");

    // The teammate finds it in their sidebar and talks to it; it runs as the owner's bot.
    await teammate.goto(`/app/${ownerBotId}`);
    await expect(teammate.getByPlaceholder(/Message/)).toBeVisible();
    await teammate.getByPlaceholder(/Message/).fill("hello from your teammate");
    await teammate.keyboard.press("Enter");
    await expect(teammate.getByTestId("message-bot-bubble").last()).toBeVisible();
    await captureScreenshot(teammate, testInfo, "shared-bot-teammate");

    // The owner's chat shows who wrote it.
    await page.reload();
    const fromTeammate = page
      .getByTestId("message-user-bubble")
      .filter({ hasText: "hello from your teammate" });
    await expect(fromTeammate).toBeVisible();
    await expect(
      page.getByTestId("transcript").getByText("Team Member", { exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, testInfo, "shared-bot-owner");
  } finally {
    await context.close();
  }
});
