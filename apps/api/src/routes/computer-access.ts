import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import {
  ACCESS_KEY_SELECT,
  accessKeyDto,
  computerAccessUrl,
  newAccessToken,
} from "../computer-access/access-keys.js";
import type { RouterContext } from "./context.js";

/** Most keys a bot keeps at once; one per AI that drives it is plenty. */
const MAX_KEYS_PER_BOT = 20;

/** Keys that let an outside AI control a bot's computer. Only the bot's owner manages them. */
export function computerAccessKeyRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  async function ownedBot(actor: Actor, botId: string) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) throw new ClientError("NOT_FOUND", "Bot not found");
    return bot;
  }

  return {
    list: authed.computer.accessKeys.list.handler(async ({ context, input }) => {
      await ownedBot(context.actor, input.botId);
      const rows = await deps.prisma.computerAccessKey.findMany({
        where: { spaceId: context.actor.spaceId, botId: input.botId, userId: context.actor.userId },
        orderBy: { createdAt: "desc" },
        select: ACCESS_KEY_SELECT,
      });
      return rows.map(accessKeyDto);
    }),
    create: authed.computer.accessKeys.create.handler(async ({ context, input }) => {
      await ownedBot(context.actor, input.botId);
      const count = await deps.prisma.computerAccessKey.count({
        where: { spaceId: context.actor.spaceId, botId: input.botId },
      });
      if (count >= MAX_KEYS_PER_BOT) {
        throw new ClientError("BAD_REQUEST", "Remove a key before adding another");
      }
      const { token, digest, hint } = newAccessToken();
      const row = await deps.prisma.computerAccessKey.create({
        data: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          botId: input.botId,
          name: input.name,
          tokenDigest: digest,
          tokenHint: hint,
          allowCommands: input.allowCommands,
        },
        select: ACCESS_KEY_SELECT,
      });
      await recordSecurityEvent({
        type: "credential.created",
        userId: context.actor.userId,
        spaceId: context.actor.spaceId,
        metadata: { kind: "computer_access_key", botId: input.botId, keyId: row.id },
      });
      const origin = deps.env.publishedInboundOrigin ?? deps.env.webOrigin;
      return { key: accessKeyDto(row), token, url: computerAccessUrl(origin) };
    }),
    remove: authed.computer.accessKeys.remove.handler(async ({ context, input }) => {
      await ownedBot(context.actor, input.botId);
      const removed = await deps.prisma.computerAccessKey.deleteMany({
        where: {
          id: input.keyId,
          botId: input.botId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        },
      });
      if (removed.count > 0) {
        await recordSecurityEvent({
          type: "credential.deleted",
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
          metadata: { kind: "computer_access_key", botId: input.botId, keyId: input.keyId },
        });
      }
      return { ok: true as const };
    }),
  };
}
