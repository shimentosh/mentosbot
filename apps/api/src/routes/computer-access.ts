import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import {
  ACCESS_KEY_SELECT,
  accessKeyDto,
  accessOrigin,
  computerAccessUrl,
  MAX_KEYS_PER_BOT,
  newAccessToken,
} from "../computer-access/access-keys.js";
import { approveAccess, grantableBots, requestedClient } from "../computer-access/oauth.js";
import type { RouterContext } from "./context.js";

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
      return { key: accessKeyDto(row), token, url: computerAccessUrl(accessOrigin(deps.env)) };
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
    request: authed.computer.accessKeys.request.handler(async ({ context, input }) => {
      const client = requestedClient(input.clientId, input.redirectUri);
      const redirect = new URL(input.redirectUri);
      return {
        clientName: client.name || "AI",
        redirectHost: redirect.host || redirect.protocol.replace(/:$/, ""),
        bots: await grantableBots(deps.prisma, context.actor),
      };
    }),
    approve: authed.computer.accessKeys.approve.handler(async ({ context, input }) => {
      const count = await deps.prisma.computerAccessKey.count({
        where: { spaceId: context.actor.spaceId, botId: input.botId },
      });
      if (count >= MAX_KEYS_PER_BOT) {
        throw new ClientError("BAD_REQUEST", "Remove one of this bot's AI keys first");
      }
      return { redirectTo: await approveAccess(deps.prisma, context.actor, input) };
    }),
  };
}
