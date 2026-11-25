import type { Actor, Bot } from "@rakazo/contracts";
import type { BotAccessLevel, createRepos, PrismaClient } from "@rakazo/db";
import {
  listSharedBots,
  recordAuditEvent,
  runAsSystem,
  runAsTenant,
  sharedBotOwner,
  teamBotForOwner,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** What a procedure needs: reading it, using it, or changing it. */
export type BotNeed = "view" | BotAccessLevel;

/**
 * The procedures a teammate may call on a bot shared with them, and the access each needs. Anything
 * missing here stays the owner's alone: archiving, deleting, exporting and sharing settings
 * outside the team routes. A shared request runs as the bot's owner, so it reaches what the bot
 * reaches; `view` is reading its chat, files and screen, `chat` is using the bot, `manage` is
 * changing it or its computer. A team's owner may view every teammate's bot.
 */
export const SHARED_BOT_PROCEDURES: Readonly<Record<string, BotNeed>> = {
  "threads.head": "view",
  "threads.get": "view",
  "threads.messages": "view",
  "threads.subscribe": "view",
  "threads.send": "chat",
  "threads.stop": "chat",
  "threads.react": "chat",
  "threads.answer": "chat",
  "threads.followUp": "chat",
  "threads.markRead": "chat",
  "threads.markUnread": "chat",
  "bots.get": "view",
  "routines.list": "view",
  "skills.list": "view",
  "memory.list": "view",
  "computer.status": "view",
  "computer.boot": "chat",
  "computer.screenUrl": "view",
  "computer.heartbeat": "view",
  "computer.files": "view",
  "computer.readFile": "view",
  "computer.downloadFile": "view",
  "artifacts.get": "view",
  "artifacts.list": "view",
  "bots.update": "manage",
  "computer.stop": "manage",
  "computer.reset": "manage",
  "computer.recover": "manage",
  "computer.update": "manage",
  "computer.dismissDiskWarning": "manage",
  "computer.takeover": "manage",
  "computer.release": "manage",
  "computer.input": "manage",
  "computer.uploadFile": "manage",
  "computer.terminalUrl": "manage",
  "computer.commands": "manage",
};

/**
 * For a request about someone else's bot shared with the caller: the bot owner's actor to run it
 * as. Undefined when the procedure isn't shareable, the bot is the caller's, or nothing is shared.
 */
export async function sharedBotActor(
  prisma: PrismaClient,
  actor: Actor,
  path: readonly string[],
  input: unknown,
): Promise<Actor | undefined> {
  const need = SHARED_BOT_PROCEDURES[path.join(".")];
  const botId =
    input && typeof input === "object" && "botId" in input && typeof input.botId === "string"
      ? input.botId
      : undefined;
  if (!need || !botId) return undefined;
  // Failing closed: without an answer the request stays the caller's own, and the caller's own
  // checks refuse a bot that isn't theirs.
  const owner = await runAsSystem("check a bot shared with a teammate", async () => {
    const shared = await sharedBotOwner(prisma, {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId,
      need,
    });
    if (shared || need !== "view") return shared;
    const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { userId: true } });
    if (!bot || bot.userId === actor.userId) return null;
    // The team's owner reads every teammate's bot, and nothing more.
    const overseen = await teamBotForOwner(prisma, {
      userId: actor.userId,
      spaceId: actor.spaceId,
      botId,
    }).catch(() => null);
    if (!overseen) return null;
    const user = await prisma.user.findUnique({
      where: { id: overseen.ownerUserId },
      select: { email: true },
    });
    if (!user) return null;
    // Watching a teammate's screen is recorded, like opening their chat.
    if (path.join(".") === "computer.screenUrl")
      await recordAuditEvent({
        action: "team.bot.screen_viewed",
        actor: { type: "user", id: actor.userId },
        spaceId: actor.spaceId,
        target: { type: "bot", id: overseen.id, label: overseen.name },
        metadata: { botOwner: overseen.ownerUserId },
      });
    return { ownerUserId: overseen.ownerUserId, ownerEmail: user.email, level: "view" as const };
  }).catch((error: unknown) => {
    getLogger().warn("shared bot lookup failed", { error });
    return null;
  });
  if (!owner) return undefined;
  return {
    userId: owner.ownerUserId,
    spaceId: actor.spaceId,
    email: owner.ownerEmail,
    isDeploymentOwner: false,
  };
}

/**
 * Bots teammates share with this person in the Space, as their owners see them, so the chat,
 * picker and settings work alike; sections and pins are the owner's and don't carry over.
 */
export async function listBotsSharedWith(
  prisma: PrismaClient,
  repos: Pick<ReturnType<typeof createRepos>, "listBots">,
  actor: Actor,
): Promise<Bot[]> {
  const shared = await runAsSystem("list bots teammates share", () =>
    listSharedBots(prisma, { userId: actor.userId, spaceId: actor.spaceId }),
  );
  const byOwner = new Map<string, typeof shared>();
  for (const entry of shared)
    byOwner.set(entry.owner.userId, [...(byOwner.get(entry.owner.userId) ?? []), entry]);
  const bots: Bot[] = [];
  for (const [ownerUserId, entries] of byOwner) {
    const owner = { ...actor, userId: ownerUserId, email: entries[0]!.owner.email };
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const owned = await runAsTenant(owner, () => repos.listBots(owner));
    for (const bot of owned) {
      const entry = byId.get(bot.id);
      if (!entry) continue;
      bots.push({
        ...bot,
        pinned: false,
        sectionId: null,
        share: {
          level: entry.level,
          ownerUserId: entry.owner.userId,
          ownerName: entry.owner.name.trim() || entry.owner.email,
        },
      });
    }
  }
  return bots;
}
