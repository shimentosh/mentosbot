/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Link, Text } from "react-email";
import { emailText, linkStyle, message } from "./email.js";

/** An invitation to join a team, sent to an address that may not have an account yet. */
export function teamInviteEmail(
  invite: { email: string; inviterName: string; teamName: string },
  acceptUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const values = { inviter: invite.inviterName, team: invite.teamName };
  return message(
    invite.email,
    locale,
    say("{inviter} invited you to {team} on Rakazo", values),
    <>
      <Text>{say("{inviter} invited you to join {team} on Rakazo.", values)}</Text>
      <Text>
        <Link href={acceptUrl} style={linkStyle}>
          {say("Join {team}", values)}
        </Link>
      </Text>
      <Text>{say("The team's owner can see its chats and activity.")}</Text>
      <Text>
        {say("This invitation expires in 7 days. Sign in with this email address to accept it.")}
      </Text>
    </>,
  );
}
