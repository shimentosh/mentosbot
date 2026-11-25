/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { displayName, textDirectionForLocale, translate } from "@rakazo/core";
import { webLightTokens as lightTokens, webDarkTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Fragment } from "react";
import {
  Body,
  Container,
  Button as EmailButton,
  Head,
  Hr,
  Html,
  Img,
  Link,
  render,
  Section,
  Text,
  toPlainText,
} from "react-email";

/** Emails are written in English, whatever language the account or the asking browser uses. */
export function emailLocale(_saved?: string | null, _headers?: Headers | null): string {
  return "en";
}

/** The language to email an account in, given the headers of the request that asked. */
export type EmailLocaleOf = (
  account: { id: string } | { email: string },
  headers?: Headers | null,
) => Promise<string>;

/** Email copy with its `{name}` placeholders filled in; every email is English. */
export function emailText(_locale: string) {
  return (text: string, values?: Record<string, string | number>) =>
    translate(undefined, text, values);
}

export function greeting(say: ReturnType<typeof emailText>, name: string): string {
  const shown = displayName(name, "");
  return shown ? say("Hi {name},", { name: shown }) : say("Hi there,");
}

export async function message(
  to: string,
  locale: string,
  subject: string,
  content: ReactNode,
  unsubscribeUrl?: string,
  image?: { src: string; alt: string },
): Promise<TransactionalEmail> {
  const html = await render(
    <Html lang={locale} dir={textDirectionForLocale(locale)}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{`@media (prefers-color-scheme: dark) {
          .email-body, .email-body > table > tbody > tr > td { background-color: ${webDarkTokens.background} !important; }
          .email-card { background-color: ${webDarkTokens.dialog} !important; color: ${webDarkTokens.foreground} !important; border-color: ${webDarkTokens.border} !important; }
          .email-card p, .email-card a { color: ${webDarkTokens.foreground} !important; }
          .email-card p.email-muted, .email-card p.email-muted a { color: ${webDarkTokens.mutedForeground} !important; }
          .email-card a.email-button { background-color: ${webDarkTokens.primary} !important; color: ${webDarkTokens.primaryForeground} !important; }
        }`}</style>
      </Head>
      <Body
        className="email-body"
        style={{
          backgroundColor: lightTokens.muted,
          color: lightTokens.foreground,
          fontFamily: "Arial, Helvetica, sans-serif",
          margin: 0,
          padding: "32px 12px",
        }}
      >
        <Container
          className="email-card"
          style={{
            maxWidth: "520px",
            backgroundColor: lightTokens.dialog,
            color: lightTokens.foreground,
            borderRadius: "12px",
            border: `1px solid ${lightTokens.border}`,
            overflow: "hidden",
          }}
        >
          {image ? (
            <Img
              src={image.src}
              alt={image.alt}
              width="520"
              style={{ width: "100%", height: "auto" }}
            />
          ) : null}
          <Section style={{ padding: "24px 32px" }}>
            {image ? null : (
              // Text, not a hosted logo: self-hosted servers send these too, and must not call out.
              <Text
                style={{
                  margin: "0 0 24px",
                  fontSize: "22px",
                  fontWeight: 600,
                  letterSpacing: "-0.5px",
                }}
              >
                rakazo
              </Text>
            )}
            {content}
            {unsubscribeUrl ? (
              <>
                <Hr style={{ borderColor: lightTokens.border, marginTop: "28px" }} />
                <FinePrint>
                  <Link href={unsubscribeUrl} style={{ color: lightTokens.mutedForeground }}>
                    {emailText(locale)("Unsubscribe")}
                  </Link>
                </FinePrint>
              </>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>,
  );
  return {
    to,
    subject,
    html,
    text: toPlainText(html),
    ...(unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  };
}

export const linkStyle = { color: lightTokens.primary, textDecoration: "underline" };

/** The one action an email asks for. */
export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "24px 0" }}>
      <EmailButton
        href={href}
        className="email-button"
        style={{
          backgroundColor: lightTokens.primary,
          color: lightTokens.primaryForeground,
          borderRadius: "8px",
          padding: "11px 20px",
          fontSize: "15px",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {children}
      </EmailButton>
    </Section>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <Text
      style={{
        margin: "24px 0",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: "28px",
        fontWeight: 600,
        letterSpacing: "6px",
      }}
    >
      {children}
    </Text>
  );
}

/** Expiry notes and "ignore this email" lines. */
export function FinePrint({ children }: { children: ReactNode }) {
  return (
    <Text
      className="email-muted"
      style={{ color: lightTokens.mutedForeground, fontSize: "13px", marginBottom: 0 }}
    >
      {children}
    </Text>
  );
}

/** Places each `{key}` of a translated sentence as its node, so links sit where the language puts them. */
export function withNodes(
  sentence: string,
  nodes: Readonly<Record<string, ReactNode>>,
): ReactNode[] {
  return sentence.split(/\{(\w+)\}/).map((part, index) => (
    // split puts each captured key at an odd index.
    <Fragment key={`${index}${part}`}>{index % 2 ? nodes[part] : part}</Fragment>
  ));
}

export function verificationEmail(
  email: string,
  url: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Verify your Rakazo email"),
    <>
      <Button href={url}>{say("Verify email")}</Button>
      <Text>{say("Then return to Rakazo to sign in.")}</Text>
      <FinePrint>
        {say("This link expires in one hour. If you did not register, ignore this email.")}
      </FinePrint>
    </>,
  );
}

export function signInCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo sign-in code"),
    <>
      <Text>{say("Enter this code to sign in to Rakazo:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </FinePrint>
    </>,
  );
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Reset your Rakazo password"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Reset your Rakazo password:")}</Text>
      <Button href={resetUrl}>{say("Reset password")}</Button>
      <FinePrint>
        {say(
          "This link expires in one hour. If you did not request this, you can ignore this email.",
        )}
      </FinePrint>
    </>,
  );
}

export function accountDeletionEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Confirm Rakazo account deletion"),
    <>
      <Text>{say("Enter this code in Rakazo to delete your account:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say(
          "This code expires in ten minutes. If you did not request deletion, ignore this email.",
        )}
      </FinePrint>
    </>,
  );
}

export function identityCodeEmail(
  email: string,
  code: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    email,
    locale,
    say("Your Rakazo confirmation code"),
    <>
      <Text>{say("Enter this code in Rakazo to confirm it's you:")}</Text>
      <Code>{code}</Code>
      <FinePrint>
        {say("This code expires in ten minutes. If you did not request it, ignore this email.")}
      </FinePrint>
    </>,
  );
}
