import { randomBytes } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  LocalKeyProvider,
  masterKeysFromEnv,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BuiltinMemoryProvider } from "./builtin-memory-provider.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;
// Row-level security binds only a runtime login separate from the migration (owner) role.
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const itWithRowSecurity = migrationUrl && migrationUrl !== databaseUrl ? it : it.skip;

describePostgres("built-in memory (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `mem-user-${suffix}`;
  const organizationId = `mem-org-${suffix}`;
  const spaceId = `mem-space-${suffix}`;
  const otherSpaceId = `mem-space-other-${suffix}`;
  const botId = `mem-bot-${suffix}`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let provider: BuiltinMemoryProvider;
  const context = (space = spaceId) =>
    ({ spaceId: space, userId, operationId: "op", traceId: "trace" }) as AdapterContext;

  beforeAll(() =>
    runAsSystem("test fixture", async () => {
      const keys = new LocalKeyProvider([
        { id: "memory-test", key: randomBytes(32) },
        ...masterKeysFromEnv(),
      ]);
      db = createDb(databaseUrl!, { keyProvider: keys, encryptContent: true });
      prisma = db.prisma;
      provider = new BuiltinMemoryProvider(prisma);
      await prisma.user.create({
        data: { id: userId, name: "Memory", email: `${userId}@rakazo.test`, emailVerified: false },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Memory", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.space.create({ data: { id: otherSpaceId, organizationId, name: "Other" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
    }),
  );

  afterAll(async () => {
    await runAsSystem("test fixture", async () => {
      await prisma?.organization.deleteMany({ where: { id: organizationId } });
      await prisma?.user.deleteMany({ where: { id: userId } });
    });
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("stores facts encrypted and recalls them by relevance for the tenant", async () => {
    await runAsTenant({ spaceId, userId }, async () => {
      for (const content of [
        "আমার সঙ্গে বাংলায় কথা বলবে",
        "Invoices for Acme go out in USD",
        "The standup is at nine",
      ]) {
        const saved = await provider.save(
          { content, scope: "isolated", botId, source: { kind: "durable" } },
          context(),
        );
        expect(saved.ok).toBe(true);
      }
      const recalled = await provider.recall(
        { query: "invoice currency for Acme", scope: "isolated", botId, limit: 5 },
        context(),
      );
      expect(recalled.ok && recalled.value.map((item) => item.memory)).toEqual([
        "Invoices for Acme go out in USD",
      ]);
      const bangla = await provider.recall(
        { query: "কোন ভাষায় কথা বলবে", scope: "isolated", botId, limit: 5 },
        context(),
      );
      expect(bangla.ok && bangla.value.map((item) => item.memory)).toEqual([
        "আমার সঙ্গে বাংলায় কথা বলবে",
      ]);
    });
    // Raw SQL skips the client's decryption, so this sees what is stored.
    const stored = await runAsSystem(
      "test fixture",
      () =>
        prisma.$queryRaw<Array<{ content: string }>>`
          SELECT content FROM semantic_memories WHERE "botId" = ${botId}`,
    );
    expect(stored).toHaveLength(3);
    for (const row of stored) expect(row.content.startsWith("rkz1:")).toBe(true);
  });

  itWithRowSecurity("keeps another Space's tenant from reading the rows", async () => {
    const rows = await runAsTenant({ spaceId: otherSpaceId, userId }, () =>
      prisma.semanticMemory.findMany({ where: { botId } }),
    );
    expect(rows).toEqual([]);
  });

  it("deletes a bot's memories with the bot", async () => {
    await runAsSystem("test fixture", () => prisma.bot.delete({ where: { id: botId } }));
    const left = await runAsSystem(
      "test fixture",
      () => prisma.$queryRaw<unknown[]>`SELECT 1 FROM semantic_memories WHERE "botId" = ${botId}`,
    );
    expect(left).toEqual([]);
  });
});
