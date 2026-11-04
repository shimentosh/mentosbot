# Teams

Invite people to an organization to work in it together.

## Invite someone

Open **Settings → Organization** and choose **Invite**. Enter their email and, if you own the
organization, a **Role**. They get an email with a link that works for 7 days. When the server
can't send email, copy the link from the dialog and send it yourself.

They open the link, sign in or create an account with that same email address, and choose **Join
team**. Inviting the same address again replaces the earlier link, and **Revoke** cancels it.

## Roles

| Role | Can |
| --- | --- |
| Owner | Everything, including making and removing admins |
| Admin | Invite and remove members |
| Member | Use the organization and see who is on the team |

Each person has their own bots and chats. Joining a team doesn't show anyone the bots you already
have. An external [memory](./memory.md) provider connected to a space serves only the bots of the
person who connected it.

## Remove someone or leave

Choose the menu next to a person, then **Remove**. Their bots in the team are archived, which stops
their runs and routines, and any space they made passes to the owner. To leave a team yourself,
choose **Leave team** next to your name. The owner can't leave.

Invitations, joins, role changes and removals are recorded in the
[audit log](./self-host-audit-log.md).
