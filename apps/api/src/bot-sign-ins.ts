import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/**
 * Puts the caller's bot in one sign-in group with another of their bots in the same Space, or back on
 * its own sign-ins when `withBotId` is null. Sign-ins are the owner's accounts, so only the owner's
 * own bots are ever grouped.
 */
export async function setBotSignIns(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  withBotId: string | null,
): Promise<void> {
  const owned = (id: string) =>
    prisma.bot.findFirst({
      where: { id, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true, signInGroup: true },
    });
  const bot = await owned(botId);
  if (!bot) throw new IsolationError();
  if (withBotId === null) {
    await prisma.bot.update({ where: { id: bot.id }, data: { signInGroup: null } });
    return;
  }
  const other = withBotId === bot.id ? null : await owned(withBotId);
  if (!other) throw new IsolationError();
  await prisma.bot.updateMany({
    where: { id: { in: [bot.id, other.id] } },
    data: { signInGroup: other.signInGroup ?? randomBytes(16).toString("hex") },
  });
}
