import { describe, expect, it } from "vitest";
import {
  accountDeletionEmail,
  emailLocale,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
import { homeDeletionEmail } from "./home-deletion-email.js";
import { modelConnectionEmail } from "./model-connection-email.js";
import {
  organizationInvitationEmail,
  spaceInvitationEmail,
} from "./organization-invitation-email.js";
import {
  integrationClaimConfirmEmail,
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
import { referralEmail } from "./referral-email.js";
import { welcomeEmail } from "./welcome-email.js";

describe("account email templates", () => {
  const url = "https://app.example.test/verify?token=fake-token&callbackURL=%2Fsign-in";

  it.each([
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
  ] as const)("preserves the exact %s link in HTML and text", async (_name, create) => {
    const message = await create();
    expect(message.to).toBe("user@example.test");
    expect(message.text).toContain(url);
    expect(message.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it.each([signInCodeEmail, accountDeletionEmail])(
    "escapes code content and includes a plain-text fallback",
    async (create) => {
      const message = await create("user@example.test", "<script>fake-code</script>");
      expect(message.text).toContain("<script>fake-code</script>");
      expect(message.html).toContain("&lt;script&gt;fake-code&lt;/script&gt;");
      expect(message.html).not.toContain("<script>");
      expect(message.html).not.toContain("<a ");
    },
  );
});

// Every template must retain the same layout and a text alternative.
it("shares the layout across account, product and marketplace emails", async () => {
  const user = { id: "user-1", name: "Alex", email: "alex@example.com" };
  const url = "https://app.example.com";
  const messages = await Promise.all([
    verificationEmail(user.email, url),
    signInCodeEmail(user.email, "123456"),
    passwordResetEmail(user, url),
    accountDeletionEmail(user.email, "123456"),
    identityCodeEmail(user.email, "123456"),
    welcomeEmail(user, url),
    homeDeletionEmail(user, new Date(), "plan-ended", url),
    homeDeletionEmail(user, new Date(), "unused", url),
    referralEmail(user, url, url),
    modelConnectionEmail(user, { webOrigin: url, unsubscribeUrl: url }),
    organizationInvitationEmail(user.email, {
      organizationName: "Acme",
      inviterName: "Sam",
      url,
    }),
    pluginSubmissionReceivedEmail(user.email),
    integrationClaimConfirmEmail(user.email, url),
    pluginSubmissionAdminEmail(
      user.email,
      { name: "Example plugin", source: "https://example.com/plugin", email: user.email },
      url,
    ),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "approved",
      reason: null,
    }),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "rejected",
      reason: "Example reason",
    }),
  ]);
  for (const message of messages) {
    expect(message.html!.match(/class="email-card"/g)).toHaveLength(1);
    expect(message.html).toContain('role="presentation"');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toContain("<table");
  }
});

describe("email language", () => {
  it("writes every email in English, whatever language is saved or asked for", async () => {
    const headers = new Headers({ "accept-language": "es-CL,es;q=0.9" });
    expect(emailLocale("es", headers)).toBe("en");
    expect(emailLocale(null, null)).toBe("en");
    const user = { id: "user-1", email: "user@example.test", name: "Ana" };
    const reset = await passwordResetEmail(user, "https://example.test/r", emailLocale("es"));
    expect(reset.text).toContain("Hi Ana,");
    const english = await welcomeEmail(user, "https://example.test/u");
    expect(english.subject).toBe("Welcome to Rakazo");
    expect(english.text).toContain("Hi Ana,");
    expect(english.text).toContain("Rakazo runs on iPhone");
  });

  it("names a Space invitation's Space, never an organization", async () => {
    const invitation = { spaceName: "Clients", inviterName: "Ana", url: "https://example.test/i" };
    const english = await spaceInvitationEmail("guest@example.test", invitation);
    expect(english.subject).toBe("Ana invited you to Clients on Rakazo");
    expect(english.text).toContain("This invitation expires in 7 days.");
    expect(english.text).not.toContain("Sign in with this email address");
  });
});

it("asks for one thing in the model connection email: the connect step", async () => {
  const unsubscribeUrl = "https://app.example.test/unsubscribe?token=fake-token";
  const message = await modelConnectionEmail(
    { name: "Ana", email: "user@example.test" },
    { webOrigin: "https://app.example.test", unsubscribeUrl },
  );
  expect(message.subject).toBe("Connect a model to start using Rakazo");
  expect(message.text).toContain("Hi Ana,");
  expect(message.text).toContain(
    "Your Rakazo plan has started, but your bots can't reply until a model is connected.",
  );
  expect(message.text).toContain(
    "Sign in with your ChatGPT or Claude subscription, or paste an API key.",
  );
  const links = [...message.html!.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  expect(links).toEqual([
    "https://app.example.test/sign-in?next=%2Fonboarding%2Fmodel",
    unsubscribeUrl,
  ]);
  expect(message.headers?.["List-Unsubscribe"]).toBe(`<${unsubscribeUrl}>`);
});
