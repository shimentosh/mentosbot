import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, IsolationError, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setBotSignIns } from "./bot-sign-ins.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot sign-in groups (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let sequence = 0;

  async function signup(): Promise<Actor> {
    const userId = `sign-ins-${++sequence}-${suffix}`;
    users.push(userId);
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId, email: `${userId}@rakazo.test`, isDeploymentOwner: false };
  }

  const bot = (actor: Actor, name: string) =>
    system.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name, color: "blue" },
    });
  const group = async (id: string) =>
    (await system.bot.findUniqueOrThrow({ where: { id } })).signInGroup;
  const set = (actor: Actor, botId: string, withBotId: string | null) =>
    runAsTenant(actor, () => setBotSignIns(prisma, actor, botId, withBotId));

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("groups the owner's bots, joins a third to the same group, and lets one leave", async () => {
    const ada = await signup();
    const scout = await bot(ada, "Scout");
    const scribe = await bot(ada, "Scribe");
    const clerk = await bot(ada, "Clerk");
    await set(ada, scout.id, scribe.id);
    const shared = await group(scout.id);
    expect(shared).toMatch(/^[0-9a-f]{32}$/);
    expect(await group(scribe.id)).toBe(shared);

    await set(ada, clerk.id, scout.id);
    expect(await group(clerk.id)).toBe(shared);

    await set(ada, scribe.id, null);
    expect(await group(scribe.id)).toBeNull();
    expect(await group(scout.id)).toBe(shared);
  });

  it("never groups with another person's bot or the bot itself", async () => {
    const ada = await signup();
    const grace = await signup();
    const adaBot = await bot(ada, "Scout");
    const graceBot = await bot(grace, "Scout");
    await expect(set(ada, adaBot.id, graceBot.id)).rejects.toBeInstanceOf(IsolationError);
    await expect(set(ada, graceBot.id, adaBot.id)).rejects.toBeInstanceOf(IsolationError);
    await expect(set(ada, adaBot.id, adaBot.id)).rejects.toBeInstanceOf(IsolationError);
    expect(await group(adaBot.id)).toBeNull();
    expect(await group(graceBot.id)).toBeNull();
  });
});
