import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { botThreadPreviews } from "../bots/bot-previews.js";
import type { Prisma, PrismaClient } from "../database/client.js";
import { IsolationError } from "../database/scope.js";
import { primaryActiveRun } from "../threads/thread-listing.js";
import { readStateFor, snoozedUntilFor, unreadFor } from "../threads/thread-reads.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type BotAccessLevel = "chat" | "manage";

export class BotShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotShareError";
  }
}

const accessLevel = (raw: string): BotAccessLevel => (raw === "manage" ? "manage" : "chat");

const satisfies = (level: string, need: BotAccessLevel | "view") =>
  need === "view" || need === "chat" || level === "manage";

/**
 * Whether a teammate may use someone else's bot for a request, and as whom it then runs: the
 * bot's owner, so it keeps the owner's apps, memory and credentials. Both people must still be in
 * the Space, and the bot not archived.
 */
export async function sharedBotOwner(
  prisma: Db,
  input: { userId: string; spaceId: string; botId: string; need: BotAccessLevel | "view" },
): Promise<{ ownerUserId: string; ownerEmail: string; level: BotAccessLevel } | null> {
  const access = await prisma.botAccess.findUnique({
    where: { botId_userId: { botId: input.botId, userId: input.userId } },
    select: {
      level: true,
      bot: {
        select: {
          userId: true,
          spaceId: true,
          archivedAt: true,
          space: {
            select: {
              deletingAt: true,
              memberships: {
                where: { userId: { in: [input.userId] } },
                select: { userId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!access || !satisfies(access.level, input.need)) return null;
  const { bot } = access;
  if (bot.spaceId !== input.spaceId || bot.archivedAt || bot.space.deletingAt) return null;
  if (bot.userId === input.userId || bot.space.memberships.length === 0) return null;
  const ownerStillIn = await prisma.spaceMember.count({
    where: { spaceId: bot.spaceId, userId: bot.userId },
  });
  if (!ownerStillIn) return null;
  const owner = await prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true },
  });
  if (!owner) return null;
  return { ownerUserId: bot.userId, ownerEmail: owner.email, level: accessLevel(access.level) };
}

/**
 * A bot this person may hand out: their own, or one shared with them to manage, never more than
 * they have. They must be in the bot's Space. Sharing follows the bot's Space rather than the
 * Space the request names, so it can be managed from the team's settings too.
 */
async function shareableBot(prisma: Db, input: { userId: string; botId: string }) {
  const bot = await prisma.bot.findFirst({
    where: {
      id: input.botId,
      archivedAt: null,
      space: { deletingAt: null, memberships: { some: { userId: input.userId } } },
    },
    select: { id: true, name: true, userId: true, spaceId: true },
  });
  if (!bot) throw new IsolationError();
  if (bot.userId === input.userId) return bot;
  const managed = await sharedBotOwner(prisma, { ...input, spaceId: bot.spaceId, need: "manage" });
  if (!managed) throw new IsolationError();
  return bot;
}

export async function listBotAccess(
  prisma: PrismaClient,
  input: { userId: string; botId: string },
) {
  await shareableBot(prisma, input);
  const rows = await prisma.botAccess.findMany({
    where: { botId: input.botId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { level: true, user: { select: { id: true, name: true, email: true } } },
  });
  return rows.map((row) => ({
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    level: accessLevel(row.level),
  }));
}

export async function shareBot(
  prisma: PrismaClient,
  input: { userId: string; botId: string; memberUserId: string; level: BotAccessLevel },
) {
  const bot = await shareableBot(prisma, input);
  if (input.memberUserId === bot.userId) throw new BotShareError("That person owns this bot");
  const inSpace = await prisma.spaceMember.count({
    where: { spaceId: bot.spaceId, userId: input.memberUserId },
  });
  if (!inSpace) throw new BotShareError("Only people on the team can be given a bot");
  await prisma.botAccess.upsert({
    where: { botId_userId: { botId: bot.id, userId: input.memberUserId } },
    create: {
      botId: bot.id,
      userId: input.memberUserId,
      level: input.level,
      grantedByUserId: input.userId,
    },
    update: { level: input.level, grantedByUserId: input.userId },
  });
  return bot;
}

export async function unshareBot(
  prisma: PrismaClient,
  input: { userId: string; botId: string; memberUserId: string },
) {
  // Anyone may give back a bot shared with them.
  if (input.memberUserId !== input.userId) await shareableBot(prisma, input);
  const removed = await prisma.botAccess.deleteMany({
    where: { botId: input.botId, userId: input.memberUserId },
  });
  return removed.count > 0;
}

export interface GrantableBotRow {
  id: string;
  name: string;
  color: string;
  avatarSet: string;
  /** The Space's name when it is not the team's default one. */
  spaceName: string | null;
  /** What the member already has, when listing for a member. */
  level: BotAccessLevel | null;
}

/**
 * The bots this person may hand out in a team: in every Space they share with the member, or for
 * someone not yet joined, in the team's default Space, which joining puts them in.
 */
export async function listGrantableBots(
  prisma: Db,
  input: { userId: string; organizationId: string; memberUserId?: string },
): Promise<GrantableBotRow[]> {
  const memberUserId = input.memberUserId;
  const spaces = await prisma.space.findMany({
    where: {
      organizationId: input.organizationId,
      deletingAt: null,
      AND: [
        { memberships: { some: { userId: input.userId } } },
        memberUserId ? { memberships: { some: { userId: memberUserId } } } : { isDefault: true },
      ],
    },
    select: { id: true, name: true, isDefault: true },
  });
  if (spaces.length === 0) return [];
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const bots = await prisma.bot.findMany({
    where: {
      spaceId: { in: [...spaceById.keys()] },
      archivedAt: null,
      OR: [
        { userId: input.userId },
        { access: { some: { userId: input.userId, level: "manage" } } },
      ],
      ...(memberUserId ? { NOT: { userId: memberUserId } } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      name: true,
      color: true,
      avatarSet: true,
      spaceId: true,
      access: memberUserId ? { where: { userId: memberUserId }, select: { level: true } } : false,
    },
  });
  return bots.map((bot) => {
    const space = spaceById.get(bot.spaceId);
    const granted = bot.access?.[0];
    return {
      id: bot.id,
      name: bot.name,
      color: bot.color,
      avatarSet: bot.avatarSet,
      spaceName: space && !space.isDefault ? space.name : null,
      level: granted ? accessLevel(granted.level) : null,
    };
  });
}

export interface InvitationBotGrant {
  botId: string;
  level: BotAccessLevel;
}

/**
 * Records the bots an invitation hands out. Each must be one the inviter may hand out in the
 * team's default Space; a carried-over grant that no longer is just drops.
 */
export async function saveInvitationBots(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    organizationId: string;
    invitationId: string;
    grants: InvitationBotGrant[];
    strict: boolean;
  },
) {
  if (input.grants.length === 0) return;
  const allowed = new Set(
    (
      await listGrantableBots(tx, { userId: input.userId, organizationId: input.organizationId })
    ).map((bot) => bot.id),
  );
  const unique = new Map(input.grants.map((grant) => [grant.botId, grant.level]));
  if (input.strict && [...unique.keys()].some((botId) => !allowed.has(botId)))
    throw new BotShareError("One of these bots can't be shared");
  const rows = [...unique]
    .filter(([botId]) => allowed.has(botId))
    .map(([botId, level]) => ({ invitationId: input.invitationId, botId, level }));
  if (rows.length) await tx.invitationBotAccess.createMany({ data: rows });
}

export async function invitationBots(db: Db, invitationId: string): Promise<InvitationBotGrant[]> {
  const rows = await db.invitationBotAccess.findMany({
    where: { invitationId },
    select: { botId: true, level: true },
  });
  return rows.map((row) => ({ botId: row.botId, level: accessLevel(row.level) }));
}

/**
 * Gives a person who just joined the bots their invitation named, as the inviter shared them.
 * A bot that was archived since, left the Space, or that the inviter may no longer hand out is
 * skipped rather than failing the join.
 */
export async function applyInvitationBots(
  tx: Prisma.TransactionClient,
  input: { invitationId: string; userId: string; inviterId: string },
): Promise<number> {
  const grants = await tx.invitationBotAccess.findMany({
    where: { invitationId: input.invitationId },
    select: {
      botId: true,
      level: true,
      bot: { select: { userId: true, spaceId: true, archivedAt: true } },
    },
  });
  let applied = 0;
  for (const grant of grants) {
    const { bot } = grant;
    if (bot.archivedAt || bot.userId === input.userId) continue;
    const inSpace = await tx.spaceMember.count({
      where: { spaceId: bot.spaceId, userId: input.userId },
    });
    if (!inSpace) continue;
    const inviterMay =
      bot.userId === input.inviterId ||
      (await sharedBotOwner(tx, {
        userId: input.inviterId,
        spaceId: bot.spaceId,
        botId: grant.botId,
        need: "manage",
      })) !== null;
    if (!inviterMay) continue;
    await tx.botAccess.upsert({
      where: { botId_userId: { botId: grant.botId, userId: input.userId } },
      create: {
        botId: grant.botId,
        userId: input.userId,
        level: grant.level,
        grantedByUserId: input.inviterId,
      },
      update: { level: grant.level, grantedByUserId: input.inviterId },
    });
    applied += 1;
  }
  return applied;
}

/** Bots others share with this person in a Space, for their sidebar. */
export async function listSharedBots(
  prisma: PrismaClient,
  input: { userId: string; spaceId: string },
) {
  const rows = await prisma.botAccess.findMany({
    where: {
      userId: input.userId,
      bot: {
        spaceId: input.spaceId,
        archivedAt: null,
        space: { memberships: { some: { userId: input.userId } } },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      level: true,
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          avatarSet: true,
          userId: true,
        },
      },
    },
  });
  if (rows.length === 0) return [];
  const owners = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.bot.userId))] } },
    select: { id: true, name: true, email: true },
  });
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  return rows.flatMap((row) => {
    const owner = ownerById.get(row.bot.userId);
    if (!owner) return [];
    return [
      {
        id: row.bot.id,
        name: row.bot.name,
        color: row.bot.color,
        avatarSet: row.bot.avatarSet,
        owner: { userId: owner.id, name: owner.name, email: owner.email },
        level: accessLevel(row.level),
      },
    ];
  });
}

/**
 * A teammate's own chat with a bot shared with them, made the first time they open it. It sits in
 * the bot's Space, so the bot's owner and the run that answers can read it.
 */
export async function memberThreadId(
  prisma: Db,
  input: { spaceId: string; botId: string; userId: string },
): Promise<string> {
  const where = { memberBotId_userId: { memberBotId: input.botId, userId: input.userId } };
  const found = await prisma.thread.findUnique({ where, select: { id: true } });
  if (found) return found.id;
  const thread = await prisma.thread.upsert({
    where,
    create: { spaceId: input.spaceId, userId: input.userId, memberBotId: input.botId },
    update: {},
    select: { id: true },
  });
  return thread.id;
}

export interface MemberThreadView {
  threadId: string;
  unread: boolean;
  snoozedUntil: string | null;
  preview: string;
  newestAt: Date;
  status: string;
}

/**
 * What a teammate's sidebar shows for bots shared with them: their own chat with each, not the
 * owner's. A chat is made here the first time, so every shared bot has one to open.
 */
export async function memberThreadViews(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; botIds: readonly string[] },
): Promise<Map<string, MemberThreadView>> {
  const views = new Map<string, MemberThreadView>();
  if (input.botIds.length === 0) return views;
  for (const botId of input.botIds) await memberThreadId(prisma, { ...input, botId });
  const threads = await prisma.thread.findMany({
    where: { memberBotId: { in: [...input.botIds] }, userId: input.userId },
    select: {
      id: true,
      memberBotId: true,
      createdAt: true,
      reads: readStateFor(input.userId),
      runs: {
        where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: { status: true },
      },
    },
  });
  const { previews, newestAt } = await botThreadPreviews(
    prisma,
    threads.map((thread) => thread.id),
  );
  for (const thread of threads) {
    if (!thread.memberBotId) continue;
    views.set(thread.memberBotId, {
      threadId: thread.id,
      unread: unreadFor(thread),
      snoozedUntil: snoozedUntilFor(thread),
      preview: previews.get(thread.id) ?? "",
      newestAt: newestAt.get(thread.id) ?? thread.createdAt,
      status: primaryActiveRun(thread.runs)?.status ?? "idle",
    });
  }
  return views;
}
