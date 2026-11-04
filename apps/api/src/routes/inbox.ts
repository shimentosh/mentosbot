import type { InboxEntry } from "@rakazo/contracts";
import { listInbox, markInboxRead, runAsSystem } from "@rakazo/db";
import type { RouterContext } from "./context.js";

export function inboxRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  // The bell spans the organization's Spaces; every query is filtered to the signed-in person.
  const organizationOf = async (spaceId: string) =>
    (
      await deps.prisma.space.findUniqueOrThrow({
        where: { id: spaceId },
        select: { organizationId: true },
      })
    ).organizationId;
  return {
    inbox: {
      list: authed.inbox.list.handler(({ context }) =>
        runAsSystem("list a person's bell across their organization's Spaces", async () => {
          const inbox = await listInbox(deps.prisma, {
            userId: context.actor.userId,
            organizationId: await organizationOf(context.actor.spaceId),
          });
          const dto = (entry: (typeof inbox.recent)[number]): InboxEntry => ({
            ...entry,
            // An unknown stored set shows the default rather than failing the whole bell.
            bot: {
              ...entry.bot,
              avatarSet: entry.bot.avatarSet === "rakazo" ? "rakazo" : "organic",
            },
            at: entry.at.toISOString(),
          });
          return {
            spaceId: context.actor.spaceId,
            needsYou: inbox.needsYou.map(dto),
            recent: inbox.recent.map(dto),
            unread: inbox.unread,
          };
        }),
      ),
      markRead: authed.inbox.markRead.handler(({ context }) =>
        runAsSystem("mark a person's bell read", async () => {
          await markInboxRead(deps.prisma, {
            userId: context.actor.userId,
            organizationId: await organizationOf(context.actor.spaceId),
          });
          return { ok: true as const };
        }),
      ),
    },
  };
}
