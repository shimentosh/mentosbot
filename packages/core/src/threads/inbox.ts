import type { InboxEntry } from "@rakazo/contracts";

/** Consecutive finished (or failed) work from one bot reads as one line, unread while any is. */
export function groupRecent(entries: readonly InboxEntry[]) {
  const groups: Array<{ entry: InboxEntry; count: number; read: boolean }> = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.entry.bot.id === entry.bot.id && last.entry.kind === entry.kind) {
      last.count += 1;
      last.read &&= entry.read;
    } else groups.push({ entry, count: 1, read: entry.read });
  }
  return groups;
}
