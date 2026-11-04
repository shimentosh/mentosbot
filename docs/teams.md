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

Each person has their own bots and chats, and teammates don't see each other's. The team's owner
sees every teammate's bot under **Team** in the sidebar, can filter it by person, and can open a
bot's chat to read it, open its files and watch its computer's screen; every chat and screen they
open is recorded in the audit log. Only the owner adds
spaces to a team, so nothing in it is out of the owner's sight. Joining a team doesn't show anyone
the bots you already have elsewhere. An external [memory](./memory.md) provider connected to a space serves only the bots of the
person who connected it.

## Share a bot

Open a bot's settings and, under **Advanced**, choose **Share** next to **Shared with**, then a
teammate. **Can chat** lets them talk to the bot and see its chat, files and screen; **Can manage**
also lets them change its settings, take control of its computer and share it on. The bot still runs
as yours, with your connected apps, memory and saved sign-ins, and its chat shows who wrote each
message. A bot you share never uses your own computer from the desktop app. Choose **×** to stop
sharing; someone can also remove a shared bot from their list.

## Remove someone or leave

Choose the menu next to a person, then **Remove**. Their bots in the team are archived, which stops
their runs and routines, and any space they made passes to the owner. To leave a team yourself,
choose **Leave team** next to your name. The owner can't leave.

Invitations, joins, role changes and removals are recorded in the
[audit log](./self-host-audit-log.md).
