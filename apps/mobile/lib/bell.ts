import type { Inbox, InboxEntry } from "@rakazo/contracts";
import { groupRecent } from "@rakazo/core";

/** Where a bell entry opens: its bot's or group's chat, switching Space when it is elsewhere. */
export function bellRoute(entry: InboxEntry) {
  return entry.groupId
    ? {
        pathname: "/group-thread" as const,
        params: { groupId: entry.groupId, spaceId: entry.spaceId },
      }
    : {
        pathname: "/thread" as const,
        params: { botId: entry.bot.id, spaceId: entry.spaceId, name: entry.bot.name },
      };
}

export type BellRow =
  | { type: "header"; key: string; title: string }
  | { type: "entry"; key: string; entry: InboxEntry; count: number; highlight: boolean };

export function inboxRows(inbox: Inbox, titles: { needsYou: string; recent: string }): BellRow[] {
  const rows: BellRow[] = [];
  if (inbox.needsYou.length) {
    rows.push({ type: "header", key: "needs", title: titles.needsYou });
    for (const entry of inbox.needsYou)
      rows.push({ type: "entry", key: entry.id, entry, count: 1, highlight: true });
  }
  const recent = groupRecent(inbox.recent);
  if (recent.length) {
    rows.push({ type: "header", key: "recent", title: titles.recent });
    for (const { entry, count, read } of recent)
      rows.push({ type: "entry", key: entry.id, entry, count, highlight: !read });
  }
  return rows;
}
