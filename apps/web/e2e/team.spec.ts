import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

type OrganizationList = {
  organizations: Array<{ id: string; role: string; memberCount: number }>;
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
    expect(organizations.find((organization) => organization.role === "member")).toMatchObject({
      memberCount: 2,
    });
  } finally {
    await context.close();
  }
});
