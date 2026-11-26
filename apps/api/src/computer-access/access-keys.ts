import { createHash, randomBytes } from "node:crypto";
import type { Actor, ComputerAccessKey } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { accountDeactivated } from "@rakazo/db";

/** Keys start with this, so a leaked one is easy to recognize and report. */
const TOKEN_PREFIX = "rkc_";
const TOKEN_BYTES = 32;
/** Calls one key may make per minute; screens and pages take seconds per step, so this is ample. */
export const ACCESS_CALLS_PER_MINUTE = 120;

/** Most keys a bot keeps at once; one per AI that drives it is plenty. */
export const MAX_KEYS_PER_BOT = 20;

export const COMPUTER_ACCESS_PATH = "/api/v1/mcp";

/** The address people and outside AIs reach this deployment at. */
export function accessOrigin(env: { publishedInboundOrigin?: string; webOrigin: string }): string {
  return (env.publishedInboundOrigin ?? env.webOrigin).replace(/\/$/, "");
}

export function computerAccessUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}${COMPUTER_ACCESS_PATH}`;
}

export function digestAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newAccessToken(): { token: string; digest: string; hint: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { token, digest: digestAccessToken(token), hint: token.slice(-4) };
}

type KeyRow = {
  id: string;
  name: string;
  tokenHint: string;
  allowCommands: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export const ACCESS_KEY_SELECT = {
  id: true,
  name: true,
  tokenHint: true,
  allowCommands: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

export function accessKeyDto(row: KeyRow): ComputerAccessKey {
  return {
    id: row.id,
    name: row.name,
    hint: row.tokenHint,
    allowCommands: row.allowCommands,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Who a key acts as, and what it may reach. */
export type AccessGrant = {
  keyId: string;
  keyName: string;
  botId: string;
  allowCommands: boolean;
  actor: Actor;
};

/**
 * The grant a bearer token carries, or null for anything that should be refused the same way:
 * no such key, an archived bot, or an owner who is deactivated or no longer in the Space.
 * Runs in a system context, since the token is all the caller has.
 */
export async function resolveAccessToken(
  prisma: PrismaClient,
  token: string,
): Promise<AccessGrant | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const key = await prisma.computerAccessKey.findUnique({
    where: { tokenDigest: digestAccessToken(token) },
    select: {
      id: true,
      name: true,
      botId: true,
      spaceId: true,
      userId: true,
      allowCommands: true,
      bot: { select: { archivedAt: true, userId: true, spaceId: true } },
      user: { select: { email: true } },
    },
  });
  if (!key || key.bot.archivedAt) return null;
  // A bot handed to someone else, or moved, leaves the old owner's keys behind.
  if (key.bot.userId !== key.userId || key.bot.spaceId !== key.spaceId) return null;
  if (await accountDeactivated(prisma, key.userId)) return null;
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: key.spaceId, userId: key.userId } },
    select: { id: true },
  });
  if (!member) return null;
  return {
    keyId: key.id,
    keyName: key.name,
    botId: key.botId,
    allowCommands: key.allowCommands,
    actor: {
      userId: key.userId,
      spaceId: key.spaceId,
      email: key.user.email,
      isDeploymentOwner: false,
    },
  };
}

/**
 * Count one call against the key's one-minute window, and note when it was last used. Resolves
 * the seconds to wait when the window is full. One statement, so instances never race on it.
 */
export async function countAccessCall(prisma: PrismaClient, keyId: string): Promise<number | null> {
  // Timestamps are stored as UTC without a zone, so the window is read in UTC too.
  const rows = await prisma.$queryRaw<Array<{ windowCalls: number; windowStartedAt: Date }>>`
    UPDATE "computer_access_keys" SET
      "windowCalls" = CASE WHEN "windowStartedAt" > (now() AT TIME ZONE 'UTC') - INTERVAL '1 minute'
        THEN "windowCalls" + 1 ELSE 1 END,
      "windowStartedAt" = CASE WHEN "windowStartedAt" > (now() AT TIME ZONE 'UTC') - INTERVAL '1 minute'
        THEN "windowStartedAt" ELSE (now() AT TIME ZONE 'UTC') END,
      "lastUsedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "id" = ${keyId}
    RETURNING "windowCalls", "windowStartedAt"`;
  const row = rows[0];
  if (!row || row.windowCalls <= ACCESS_CALLS_PER_MINUTE) return null;
  const ends = row.windowStartedAt.getTime() + 60_000;
  return Math.max(1, Math.ceil((ends - Date.now()) / 1000));
}
