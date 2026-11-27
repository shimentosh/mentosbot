import type { PrismaClient } from "../database/client.js";
import { IsolationError } from "../database/scope.js";

export interface TeamUsageRow {
  userId: string;
  botId: string | null;
  botName: string | null;
  costUsd: number;
  totalTokens: number;
  calls: number;
  lastUsedAt: Date;
}

/**
 * Model spend across a team's Spaces, by the person who started the work and the bot that did
 * it, for the team's owner only. A teammate's request to a shared bot counts as theirs, though
 * it runs as the bot's owner; everything else counts as the bot owner's.
 */
export async function teamUsage(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; since: Date | null },
): Promise<TeamUsageRow[]> {
  const owner = await prisma.member.findFirst({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      role: { contains: "owner" },
    },
    select: { id: true },
  });
  if (!owner) throw new IsolationError();
  const spaces = await prisma.space.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true },
  });
  if (spaces.length === 0) return [];
  const groups = await prisma.usageRecord.groupBy({
    by: ["startedByUserId", "userId", "botId"],
    where: {
      spaceId: { in: spaces.map((space) => space.id) },
      ...(input.since ? { createdAt: { gte: input.since } } : {}),
    },
    _sum: { costUsd: true, totalTokens: true },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const rows = new Map<string, TeamUsageRow>();
  for (const group of groups) {
    const userId = group.startedByUserId ?? group.userId;
    const key = `${userId}\n${group.botId ?? ""}`;
    const row = rows.get(key) ?? {
      userId,
      botId: group.botId,
      botName: null,
      costUsd: 0,
      totalTokens: 0,
      calls: 0,
      lastUsedAt: new Date(0),
    };
    row.costUsd += group._sum.costUsd ?? 0;
    row.totalTokens += group._sum.totalTokens ?? 0;
    row.calls += group._count._all;
    const last = group._max.createdAt;
    if (last && last > row.lastUsedAt) row.lastUsedAt = last;
    rows.set(key, row);
  }
  const botIds = [...new Set([...rows.values()].flatMap((row) => (row.botId ? [row.botId] : [])))];
  if (botIds.length) {
    // A deleted bot's usage stays; its name comes from the deletion record.
    const [bots, deleted] = await Promise.all([
      prisma.bot.findMany({ where: { id: { in: botIds } }, select: { id: true, name: true } }),
      prisma.botDeletion.findMany({
        where: { id: { in: botIds } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map([...deleted, ...bots].map((bot) => [bot.id, bot.name]));
    for (const row of rows.values()) if (row.botId) row.botName = names.get(row.botId) ?? null;
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}
