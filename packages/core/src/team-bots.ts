import type { TeamBot } from "@rakazo/contracts";

/** The teammates a filter can pick, once each, in the order their bots appear. */
export function teamMembers(bots: readonly TeamBot[]) {
  const seen = new Map<string, TeamBot["owner"]>();
  for (const bot of bots) if (!seen.has(bot.owner.userId)) seen.set(bot.owner.userId, bot.owner);
  return [...seen.values()];
}

/** Teammates' active bots, all or one person's. */
export function filterTeamBots(bots: readonly TeamBot[], member: string | "all") {
  return bots.filter((bot) => !bot.archived && (member === "all" || bot.owner.userId === member));
}

export const teamPersonName = (person: { name: string; email: string }) =>
  person.name.trim() || person.email;
