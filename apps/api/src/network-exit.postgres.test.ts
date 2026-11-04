import { randomBytes } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import { loadNetworkExit } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, installAuditEventStore } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const KEY = "tskey-auth-kTest1CNTRL-0123456789abcdef";

describePostgres("network exit (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let sequence = 0;
  let networkExit = true;

  // Stands in for the encrypted store: ciphertext must never equal the plaintext.
  const secrets = {
    put: async (plaintext: string) => {
      const id = `secret-${randomBytes(6).toString("hex")}`;
      return { id, ref: id, ciphertext: Buffer.from(plaintext).toString("base64") };
    },
    load: async (ciphertext: string) => Buffer.from(ciphertext, "base64").toString(),
  } as unknown as SecretStore;
  const sandbox = {
    describe: () => ({ id: "docker", capabilities: { networkExit } }),
  } as unknown as SandboxProvider;
  const client = (actor: Actor) =>
    createRouterClient(
      createRouter({ prisma, secrets, sandbox, env: {} } as unknown as RouterDeps),
      {
        context: { actor },
      },
    );

  async function signup(): Promise<Actor> {
    const userId = `netexit-${++sequence}-${suffix}`;
    users.push(userId);
    const email = `${userId}@rakazo.test`;
    await system.user.create({ data: { id: userId, name: userId, email, emailVerified: true } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId, email, isDeploymentOwner: false };
  }

  async function computerOf(actor: Actor) {
    const homeKey = `home-${actor.userId}`;
    await system.computer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "team",
        scopeKey: `team:${actor.spaceId}:${actor.userId}`,
        homeKey,
        kind: "docker",
      },
    });
    return homeKey;
  }

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installAuditEventStore(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    installAuditEventStore(undefined);
    await system.auditEvent.deleteMany({ where: { actorId: { in: users } } });
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("connects a person's own network for their computers and never returns the key", async () => {
    const ada = await signup();
    const grace = await signup();
    const adaHome = await computerOf(ada);
    const graceHome = await computerOf(grace);

    await expect(client(ada).networkExit.get()).resolves.toEqual({
      providers: [
        expect.objectContaining({ id: "tailscale" }),
        expect.objectContaining({ id: "proxy" }),
      ],
      connection: null,
    });
    await expect(
      client(ada).networkExit.connect({
        provider: "tailscale",
        values: { authKey: "nope", exitNode: "pixel-7" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const connected = await client(ada).networkExit.connect({
      provider: "tailscale",
      values: { authKey: KEY, exitNode: "pixel-7" },
    });
    expect(connected.connection).toEqual({
      provider: "tailscale",
      values: { exitNode: "pixel-7" },
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(connected)).not.toContain(KEY);
    const row = await system.computerNetworkExit.findFirstOrThrow({
      where: { userId: ada.userId },
      include: { secret: true },
    });
    expect(JSON.stringify(row)).not.toContain(KEY);

    // Saving again without retyping the key keeps it.
    await client(ada).networkExit.connect({
      provider: "tailscale",
      values: { exitNode: "apple-tv" },
    });
    await expect(loadNetworkExit(system, secrets, adaHome)).resolves.toEqual({
      provider: "tailscale",
      settings: { exitNode: "apple-tv" },
      credentials: { authKey: KEY },
    });
    await expect(
      system.secret.count({ where: { userId: ada.userId, kind: "network-exit" } }),
    ).resolves.toBe(1);

    // Only the owner's computers use it.
    await expect(loadNetworkExit(system, secrets, graceHome)).resolves.toBeUndefined();
    await expect(client(grace).networkExit.get()).resolves.toMatchObject({ connection: null });

    await expect(
      system.auditEvent.count({
        where: { actorId: ada.userId, action: "network_exit.connected" },
      }),
    ).resolves.toBe(2);

    await expect(client(ada).networkExit.disconnect()).resolves.toMatchObject({
      connection: null,
    });
    await expect(loadNetworkExit(system, secrets, adaHome)).resolves.toBeUndefined();
    await expect(
      system.secret.count({ where: { userId: ada.userId, kind: "network-exit" } }),
    ).resolves.toBe(0);
  });

  it("connects a plain proxy too, with its password kept out of what is shown", async () => {
    const ada = await signup();
    const home = await computerOf(ada);
    const connected = await client(ada).networkExit.connect({
      provider: "proxy",
      values: { address: "proxy.example.com:8080", username: "me", password: "s3cret" },
    });
    expect(connected.connection).toMatchObject({
      provider: "proxy",
      values: { address: "proxy.example.com:8080", username: "me" },
    });
    expect(JSON.stringify(connected)).not.toContain("s3cret");
    await expect(loadNetworkExit(system, secrets, home)).resolves.toEqual({
      provider: "proxy",
      settings: { address: "proxy.example.com:8080", username: "me" },
      credentials: { password: "s3cret" },
    });
    await expect(
      client(ada).networkExit.connect({ provider: "proxy", values: { address: "10.0.0.2:3128" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("offers nothing where computers can't use it", async () => {
    const ada = await signup();
    networkExit = false;
    try {
      await expect(client(ada).networkExit.get()).resolves.toEqual({
        providers: [],
        connection: null,
      });
      await expect(
        client(ada).networkExit.connect({
          provider: "tailscale",
          values: { authKey: KEY, exitNode: "pixel-7" },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      networkExit = true;
    }
  });
});
