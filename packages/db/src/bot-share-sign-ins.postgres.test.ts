import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("new bots and shared sign-ins (PostgreSQL)", () => {
  const provider = "sendblue";
  // A prefix no other test file uses, so parallel files never share this account.
  const address = `+1557${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "sign-ins@example.com",
    isDeploymentOwner: false,
  });
  const create = (name: string) =>
    runAsTenant(owner, () =>
      createRepos(prisma).createBot(actor(), {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (prisma && owner) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      await system.organization.deleteMany({ where: { id: owner.spaceId } });
      await system.user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("starts every new bot on the global browser, even when the others are independent", async () => {
    const system = asSystem(prisma);
    await system.bot.updateMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      data: { shareSignIns: false },
    });
    expect((await create("First")).shareSignIns).toBe(true);
  });
});
