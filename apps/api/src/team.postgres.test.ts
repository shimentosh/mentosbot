import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import type {
  ArtifactStore,
  JobPublisher,
  SandboxProvider,
  TransactionalEmail,
  TransactionalEmailProvider,
} from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createRepos,
  crossSpaceCommunicationAllowed,
  IsolationError,
  installAuditEventStore,
  requireMembership,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("team membership (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  const sent: TransactionalEmail[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let root: string;
  let sequence = 0;
  let emailEnabled = true;

  const email: TransactionalEmailProvider = {
    send: async (message) => {
      sent.push(message);
    },
  } as TransactionalEmailProvider;
  const deps = () =>
    ({
      prisma,
      env: { webOrigin: "https://app.example.test" },
      sandbox: { releaseScreen: async () => {} } as unknown as SandboxProvider,
      home: {},
      jobs: { cancel: vi.fn(), enqueue: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
      email: emailEnabled ? email : undefined,
    }) as unknown as RouterDeps;
  const client = (actor: Actor) => createRouterClient(createRouter(deps()), { context: { actor } });

  async function signup(options: { verified?: boolean; email?: string } = {}): Promise<Actor> {
    const userId = `team-${++sequence}-${suffix}`;
    users.push(userId);
    const address = options.email ?? `${userId}@rakazo.test`;
    await system.user.create({
      data: {
        id: userId,
        name: `Person ${sequence}`,
        email: address,
        emailVerified: options.verified ?? true,
      },
    });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    return { userId, spaceId, email: address, isDeploymentOwner: false };
  }

  /** Invites, then returns the link token from the email the invitee would receive. */
  async function invite(owner: Actor, to: string, role: "admin" | "member" = "member") {
    const { id, emailSent } = await client(owner).team.invite({
      organizationId: owner.spaceId,
      email: to,
      role,
    });
    expect(emailSent).toBe(true);
    expect(sent.at(-1)?.to).toBe(to.toLowerCase());
    expect(sent.at(-1)?.html).toContain(`https://app.example.test/invite/${id}`);
    return id;
  }

  async function join(owner: Actor, role: "admin" | "member" = "member") {
    const person = await signup();
    const invitationId = await invite(owner, person.email, role);
    await client(person).team.accept({ invitationId });
    return { ...person, spaceId: owner.spaceId };
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installAuditEventStore(prisma);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-team-"));
  });

  afterAll(async () => {
    if (!db) return;
    installAuditEventStore(undefined);
    await system.auditEvent.deleteMany({ where: { actorId: { in: users } } });
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await rm(root, { recursive: true, force: true });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("invites by email, and the invited account joins the team's default Space", async () => {
    const owner = await signup();
    const ada = await signup();
    const invitationId = await invite(owner, ada.email.toUpperCase());

    await expect(client(ada).team.invitation({ invitationId })).resolves.toEqual({
      organizationName: "Personal",
      inviterName: expect.any(String),
      role: "member",
    });
    await expect(client(ada).team.accept({ invitationId })).resolves.toEqual({
      organizationId: owner.spaceId,
      defaultSpaceId: owner.spaceId,
    });

    await expect(requireMembership(system, ada.userId, owner.spaceId)).resolves.toMatchObject({
      spaceId: owner.spaceId,
    });
    const team = await client(owner).team.get({ organizationId: owner.spaceId });
    expect(team.members.map(({ userId, role }) => ({ userId, role }))).toEqual([
      { userId: owner.userId, role: "owner" },
      { userId: ada.userId, role: "member" },
    ]);
    const organizations = await client(ada).organizations.list();
    expect(organizations.organizations.find((org) => org.id === owner.spaceId)).toMatchObject({
      role: "member",
      canManage: false,
      memberCount: 2,
    });
    await expect(
      system.auditEvent.count({
        where: { organizationId: owner.spaceId, action: { startsWith: "team.member." } },
      }),
    ).resolves.toBe(2);

    // A used link cannot admit anyone again.
    await expect(client(ada).team.accept({ invitationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("admits only the invited, verified address, and only while the link is current", async () => {
    const owner = await signup();
    const invited = await signup({ verified: false });
    const stranger = await signup();
    const unavailable = { code: "NOT_FOUND", message: "This invitation is no longer available" };

    const invitationId = await invite(owner, invited.email);
    // Someone holding the link with another account learns nothing about the team.
    await expect(client(stranger).team.invitation({ invitationId })).rejects.toMatchObject(
      unavailable,
    );
    await expect(client(stranger).team.accept({ invitationId })).rejects.toMatchObject(unavailable);
    // A server that sends email requires the address to be proven first.
    await expect(client(invited).team.accept({ invitationId })).rejects.toMatchObject(unavailable);
    await system.user.update({ where: { id: invited.userId }, data: { emailVerified: true } });

    // Inviting again replaces the earlier link.
    const replacement = await invite(owner, invited.email);
    await expect(client(invited).team.accept({ invitationId })).rejects.toMatchObject(unavailable);

    await system.invitation.update({
      where: { id: replacement },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(client(invited).team.accept({ invitationId: replacement })).rejects.toMatchObject(
      unavailable,
    );

    // Revoked links stop working too.
    const revoked = await invite(owner, invited.email);
    await client(owner).team.revokeInvitation({ invitationId: revoked });
    await expect(client(invited).team.accept({ invitationId: revoked })).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      system.member.count({ where: { organizationId: owner.spaceId, userId: invited.userId } }),
    ).resolves.toBe(0);
  });

  it("without email delivery, the link and matching address are enough", async () => {
    const owner = await signup();
    const invited = await signup({ verified: false });
    emailEnabled = false;
    try {
      const { id, emailSent } = await client(owner).team.invite({
        organizationId: owner.spaceId,
        email: invited.email,
        role: "member",
      });
      expect(emailSent).toBe(false);
      await expect(client(invited).team.accept({ invitationId: id })).resolves.toMatchObject({
        organizationId: owner.spaceId,
      });
    } finally {
      emailEnabled = true;
    }
  });

  it("keeps team management to owners and admins, and admins below the owner", async () => {
    const owner = await signup();
    const admin = await join(owner, "admin");
    const member = await join(owner);
    const forbidden = { code: "FORBIDDEN" };

    // Members see who is on the team but not pending invitations, and change nothing.
    await invite(owner, "pending@rakazo.test");
    const asMember = await client(member).team.get({ organizationId: owner.spaceId });
    expect(asMember.role).toBe("member");
    expect(asMember.invitations).toEqual([]);
    expect(
      (await client(admin).team.get({ organizationId: owner.spaceId })).invitations,
    ).toHaveLength(1);
    await expect(
      client(member).team.invite({
        organizationId: owner.spaceId,
        email: "someone@rakazo.test",
        role: "member",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      client(member).team.remove({ organizationId: owner.spaceId, userId: admin.userId }),
    ).rejects.toMatchObject(forbidden);

    // Admins invite members, but neither admins nor changes to the owner.
    await expect(
      client(admin).team.invite({
        organizationId: owner.spaceId,
        email: "teammate@rakazo.test",
        role: "member",
      }),
    ).resolves.toMatchObject({ emailSent: true });
    await expect(
      client(admin).team.invite({
        organizationId: owner.spaceId,
        email: "boss@rakazo.test",
        role: "admin",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      client(admin).team.setRole({
        organizationId: owner.spaceId,
        userId: member.userId,
        role: "admin",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      client(admin).team.remove({ organizationId: owner.spaceId, userId: owner.userId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      client(owner).team.remove({ organizationId: owner.spaceId, userId: owner.userId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      client(owner).team.invite({
        organizationId: owner.spaceId,
        email: member.email,
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await client(owner).team.setRole({
      organizationId: owner.spaceId,
      userId: admin.userId,
      role: "member",
    });
    await expect(
      system.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: admin.userId } },
      }),
    ).resolves.toMatchObject({ role: "member" });

    // Another organization's team is not found at all.
    const outsider = await signup();
    await expect(
      client(outsider).team.get({ organizationId: owner.spaceId }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("removing a member stops their work, keeps their bots and hands their Spaces to the owner", async () => {
    const owner = await signup();
    const member = await join(owner);
    // A Space a member made before only owners could add them: the member owns it.
    const side = await client(owner).spaces.create({ name: "Side" });
    await system.spaceMember.create({
      data: {
        id: `side-${member.userId}`,
        spaceId: side.id,
        organizationId: owner.spaceId,
        userId: member.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.updateMany({
      where: { spaceId: side.id, userId: owner.userId },
      data: { role: "member" },
    });
    const bot = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: member.userId, name: "Helper", color: "blue" },
    });

    await client(owner).team.remove({ organizationId: owner.spaceId, userId: member.userId });

    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      archivedAt: expect.any(Date),
    });
    await expect(requireMembership(system, member.userId, owner.spaceId)).rejects.toThrow();
    await expect(
      system.spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: side.id, userId: owner.userId } },
      }),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(
      system.spaceMember.count({ where: { organizationId: owner.spaceId, userId: member.userId } }),
    ).resolves.toBe(0);
    await expect(
      system.auditEvent.count({
        where: { organizationId: owner.spaceId, action: "team.member.removed" },
      }),
    ).resolves.toBe(1);
  });

  it("keeps teammates' bots apart in the shared Space", async () => {
    const owner = await signup();
    const member = await join(owner);
    const repos = createRepos(system);
    const first = { description: "", instructions: "", notifyOnFinish: false };

    // Each person's onboarding creates their own first bot, even in a Space someone already has one in.
    const ownerBot = await runAsTenant(owner, () =>
      repos.createBot(owner, { ...first, name: "Owner's", spawnKey: "onboarding:first" }),
    );
    const memberBot = await runAsTenant(member, () =>
      repos.createBot(member, { ...first, name: "Member's", spawnKey: "onboarding:first" }),
    );
    expect(memberBot.id).not.toBe(ownerBot.id);
    await expect(
      runAsTenant(member, () =>
        repos.createBot(member, { ...first, name: "Again", spawnKey: "onboarding:first" }),
      ),
    ).resolves.toMatchObject({ id: memberBot.id });

    // Sharing a Space is not sharing an owner: a bot that turned off talking to other people's
    // bots stays off.
    await expect(crossSpaceCommunicationAllowed(system, ownerBot.id, memberBot.id)).resolves.toBe(
      true,
    );
    await system.bot.update({
      where: { id: memberBot.id },
      data: { crossSpaceCommunication: false },
    });
    await expect(crossSpaceCommunicationAllowed(system, ownerBot.id, memberBot.id)).resolves.toBe(
      false,
    );
  });

  it("lets the team's owner see and read every teammate's bot, and nobody else", async () => {
    const owner = await signup();
    const ada = await join(owner);
    const grace = await join(owner);
    const bot = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: ada.userId, name: "Ada's helper", color: "blue" },
    });
    const thread = await system.thread.create({
      data: { spaceId: owner.spaceId, userId: ada.userId, botId: bot.id },
    });
    await system.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "hello" }],
      },
    });

    const listed = await client(owner).team.bots();
    expect(listed).toEqual([
      expect.objectContaining({
        id: bot.id,
        name: "Ada's helper",
        owner: expect.objectContaining({ userId: ada.userId }),
        status: "idle",
        archived: false,
      }),
    ]);
    const page = await client(owner).team.botMessages({ botId: bot.id });
    expect(JSON.stringify(page)).toContain("hello");
    await expect(
      system.auditEvent.count({
        where: { organizationId: owner.spaceId, action: "team.bot.viewed", targetId: bot.id },
      }),
    ).resolves.toBe(1);

    // Teammates see none of each other's bots, here or through the owner's view.
    await expect(client(grace).team.bots()).resolves.toEqual([]);
    await expect(client(grace).team.botMessages({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
    // Reading is all the owner gets: using the chat stays the bot owner's.
    await expect(client(owner).threads.markRead({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );

    // Members keep their own work in their own organization; the team's Spaces are the owner's.
    await expect(client(ada).spaces.create({ name: "Hidden" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client(owner).spaces.create({ name: "Projects" })).resolves.toMatchObject({
      name: "Projects",
    });
  });

  it("shares a bot with chosen teammates, at the access it was given and no further", async () => {
    const owner = await signup();
    const ada = await join(owner);
    const grace = await join(owner);
    const bot = await runAsTenant(owner, () =>
      createRepos(prisma).createBot(owner, {
        name: "Shared helper",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const listedFor = async (actor: Actor) =>
      (await client(actor).bots.list()).filter((each) => each.id === bot.id);

    // Not shared: invisible and unreadable.
    await expect(listedFor(ada)).resolves.toEqual([]);
    await expect(client(ada).threads.messages({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );

    await expect(
      client(owner).team.shareBot({ botId: bot.id, userId: ada.userId, level: "chat" }),
    ).resolves.toEqual([expect.objectContaining({ userId: ada.userId, level: "chat" })]);
    await expect(listedFor(ada)).resolves.toEqual([
      expect.objectContaining({
        id: bot.id,
        share: { level: "chat", ownerUserId: owner.userId, ownerName: expect.any(String) },
      }),
    ]);
    await expect(client(ada).bots.get({ botId: bot.id })).resolves.toMatchObject({
      share: { level: "chat" },
    });
    await expect(client(ada).threads.messages({ botId: bot.id })).resolves.toMatchObject({
      threadId: bot.threadId,
    });
    // Using it is not managing it: no sharing it on, and others still see nothing.
    await expect(
      client(ada).team.shareBot({ botId: bot.id, userId: grace.userId, level: "chat" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(client(ada).team.botAccess({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(listedFor(grace)).resolves.toEqual([]);

    // Managing it lets them share it on.
    await client(owner).team.shareBot({ botId: bot.id, userId: ada.userId, level: "manage" });
    await client(ada).team.shareBot({ botId: bot.id, userId: grace.userId, level: "chat" });
    await expect(listedFor(grace)).resolves.toHaveLength(1);

    // Only teammates, and never the owner, can be given it.
    const outsider = await signup();
    await expect(
      client(owner).team.shareBot({ botId: bot.id, userId: outsider.userId, level: "chat" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client(ada).team.shareBot({ botId: bot.id, userId: owner.userId, level: "chat" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Giving it back, taking it away, and leaving the team all end access.
    await client(grace).team.unshareBot({ botId: bot.id, userId: grace.userId });
    await expect(listedFor(grace)).resolves.toEqual([]);
    await client(owner).team.unshareBot({ botId: bot.id, userId: ada.userId });
    await expect(client(ada).threads.messages({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await client(owner).team.shareBot({ botId: bot.id, userId: ada.userId, level: "chat" });
    await client(owner).team.remove({ organizationId: owner.spaceId, userId: ada.userId });
    await expect(system.botAccess.count({ where: { userId: ada.userId } })).resolves.toBe(0);
    await expect(
      system.auditEvent.count({
        where: {
          organizationId: owner.spaceId,
          action: { in: ["team.bot.shared", "team.bot.unshared"] },
        },
      }),
    ).resolves.toBe(6);
  });

  it("lets the team's owner read a teammate's bot, its files and screen, but not use it", async () => {
    const owner = await signup();
    const ada = await join(owner);
    const grace = await join(owner);
    const bot = await runAsTenant(ada, () =>
      createRepos(prisma).createBot(ada, {
        name: "Ada's researcher",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    await expect(client(owner).bots.get({ botId: bot.id })).resolves.toMatchObject({ id: bot.id });
    await expect(client(owner).threads.messages({ botId: bot.id })).resolves.toMatchObject({
      threadId: bot.threadId,
    });
    await expect(client(owner).artifacts.list({ botId: bot.id })).resolves.toEqual([]);
    // Using or changing it stays with its owner.
    await expect(
      client(owner).bots.update({ botId: bot.id, name: "Mine now" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(client(owner).threads.markRead({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
    // Teammates get no such view.
    await expect(client(grace).threads.messages({ botId: bot.id })).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it("lets a member leave on their own", async () => {
    const owner = await signup();
    const member = await join(owner);
    await client(member).team.remove({ organizationId: owner.spaceId, userId: member.userId });
    await expect(
      system.member.count({ where: { organizationId: owner.spaceId, userId: member.userId } }),
    ).resolves.toBe(0);
  });
});
