# The bot's computer

Every bot has a real computer with a browser, a terminal, files and a desktop, so it can do work
that needs more than a chat.

## Watch it work

Choose **Agent computer** at the top of the chat to open the bot's screen beside the conversation.
Choose **Open in full window** for a larger view. The computer starts when a bot needs it and goes
to sleep when idle; opening it wakes it.

On mobile, open the bot's profile and choose **Open computer**.

## Take control

Choose **Take control** to use the screen yourself, for example to sign in to a site. The header
shows **You have control** until you choose **Release control** (**Release** on mobile).

When the bot hits something only you can do, such as a CAPTCHA or a code texted to your phone, it
asks you to take over. The header shows **Needs you**. Do the step, then choose **I’m done**, or
**Skip** to let the bot carry on without it.

> [!TIP]
> Want the bot to sign in by itself next time? Ask it to save the login. See
> [Reusable credentials](./bot-secrets.md).

## Team or Private

In the bot's settings under **Advanced**, **Computer** is **Team** or **Private**.

- **Team** (the default): bots in the [space](./spaces.md) share one Team Computer, with the same
  files and installed tools. Each bot gets its own screen and browser, and sites you sign in to are
  carried over to the other bots.
- **Private**: the bot gets a computer of its own. Use it when files or sign-ins must not be shared
  with other bots.

## Files

Bots save their work on the computer and send you the results as files in the chat. Every file a bot
has sent is also under **Artifacts** in the account menu.

To have a bot react to files changing, use a [routine](./routines.md) that watches a folder.

## Fix a computer

Open the computer and choose **More computer actions**:

- **Stop computer**: shut it down now. It starts again when needed.
- **Update computer**: save the workspace and install current software.
- **Recover computer**: recreate a computer that is not working.
- **Reset computer**: go back to the last saved workspace. Unsaved work on the computer is lost.

## Use your own computer

In the [desktop app](./desktop-app.md), bots can also run commands on the computer the app is
installed on. Turn on **Let bots use this computer** in **Settings → General** under **Computers**.
In every [approval mode](./approvals.md), a bot asks before its first command in a space and before
it first uses each app there, unless a Block rule refuses it. **Allow in this space** covers the
rest of that space, in any chat, until you remove the computer from the same list.

> [!WARNING]
> A bot with access to your computer can read your files and run programs as you. Only turn it on
> for a computer you would let your bots use unattended.

### Project folder

Ask a bot to work in a folder on your computer, such as a code or content project, and it keeps
that folder as its project folder. Its commands start there, and it follows the folder's
`AGENTS.md` or `CLAUDE.md` and uses the skills in `.claude/skills` or `.agents/skills`. The folder
must be inside your home folder. A bot asks before setting one, and each person has their own. Ask
the bot to stop using it to clear it.

You can also choose it yourself: open the bot's **Computer** tab and press **Choose folder** under
**Project folder**. The desktop app opens your system's own folder picker on the computer you are
using. In a browser, press **Use** beside a project (folders with a `.git`, `package.json` or
similar are marked) or **Use this folder** inside one. In the desktop app, **New bot** also offers
**Start from a project folder**, which names the bot after the folder.

With more than one computer signed in, the folder stays tied to the computer it is on: the bot
works there whenever that computer is connected. To sign a computer out, remove it from the list
under **Computers** in **Settings → General**.

A bot can keep a command running on your computer, such as a dev server or a watcher, past the
time an ordinary command is given. It keeps running after the chat moves on, even if the desktop app
quits, until the bot or you stop it. The **Project folder** section lists what each bot keeps
running, with a link to each port it listens on and a **Stop** button. This needs macOS or Linux.

When a project is an app with a local API, such as a studio running on `http://127.0.0.1:3000`, a
bot can call that API from your computer instead of typing commands: it starts the app, sends it
requests and reads the answers. Only addresses on the computer itself (`127.0.0.1` or `localhost`)
can be called, and the first call asks like a command does.

Your own [routines](./routines.md) for a bot reach your computer too, as your messages do, and so
does work one of your bots hands to another when it began with your own message or routine. A
routine someone else set up, a bot shared with teammates, and work that began in a channel, a
webhook or another person's message never do.

With a project folder set, a bot can hand bigger jobs to the coding agent installed on that
computer (for example a command-line coding assistant you have signed in to in your terminal). The
agent works in the folder with the project's own instructions, can run for up to an hour, and
answers the bot, which keeps the same agent session going with your replies. The bot asks before it
first hands work to the agent in a space; **Allow in this space** covers the rest of that space.
Anything the agent would need a person to approve is refused, not left waiting.

A bot can also send a file from your computer to the chat, such as a video rendered there. It goes
through the server into [artifact storage](./self-host-storage.md#shared-storage-migration), so with
object storage connected it is kept in your bucket, encrypted. Files over `MAX_UPLOAD_SIZE_MB`
(10 MB by default) are refused; raise it on the server for longer videos.
