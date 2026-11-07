import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { listApprovals, listInbox, markInboxRead, recordInboxNotification } from "./inbox.js";
import { createOrganizationForUser } from "./organizations.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("the bell (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let sequence = 0;

  async function person() {
    const userId = `bell-${++sequence}-${suffix}`;
    users.push(userId);
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: true },
    });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const organizationId = (
      await system.space.findUniqueOrThrow({
        where: { id: spaceId },
        select: { organizationId: true },
      })
    ).organizationId;
    return { userId, spaceId, organizationId };
  }

  async function botRun(owner: { userId: string; spaceId: string }, name: string, status: string) {
    const actor = { ...owner, email: "bell@rakazo.test", isDeploymentOwner: false };
    return runAsTenant(owner, async () => {
      const bot = await createRepos(prisma).createBot(actor, {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      const task = await prisma.task.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: "test",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          status,
          trigger: "user_message",
        },
      });
      return { bot, run };
    });
  }

  const record = (
    owner: { userId: string; spaceId: string },
    target: { bot: { id: string; threadId: string }; run: { id: string } },
    kind: Parameters<typeof recordInboxNotification>[1]["kind"],
  ) =>
    runAsTenant(owner, () =>
      recordInboxNotification(prisma, {
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId: target.bot.id,
        threadId: target.bot.threadId,
        runId: target.run.id,
        kind,
      }),
    );

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  it("lists what waits on the person until it is answered, on any device", async () => {
    const ada = await person();
    const asking = await botRun(ada, "Asker", "waiting_input");
    const screen = await botRun(ada, "Screen", "waiting_takeover");
    const quiet = await botRun(ada, "Quiet", "waiting_input");
    await record(ada, asking, "approval");

    const inbox = await listInbox(system, ada);
    expect(Object.fromEntries(inbox.needsYou.map((entry) => [entry.bot.name, entry.kind]))).toEqual(
      {
        Asker: "approval",
        Screen: "takeover",
        // A run that waits without having sent anything still needs an answer.
        Quiet: "answer",
      },
    );
    expect(inbox.needsYou[0]).toMatchObject({ spaceId: ada.spaceId, spaceName: "Personal" });

    await system.run.update({ where: { id: asking.run.id }, data: { status: "running" } });
    await system.run.update({ where: { id: screen.run.id }, data: { status: "completed" } });
    await system.bot.update({ where: { id: quiet.bot.id }, data: { archivedAt: new Date() } });
    await expect(listInbox(system, ada)).resolves.toMatchObject({ needsYou: [] });
  });

  it("lists each waiting run with the newest card it still needs answered, oldest run first", async () => {
    const ada = await person();
    const post = await botRun(ada, "Poster", "waiting_input");
    await botRun(ada, "Screen", "waiting_takeover");
    const message = (
      target: { bot: { threadId: string }; run: { id: string } },
      seq: number,
      blocks: unknown[],
    ) =>
      runAsTenant(ada, () =>
        prisma.message.create({
          data: {
            threadId: target.bot.threadId,
            seq,
            role: "bot",
            runId: target.run.id,
            blocks: blocks as object[],
          },
        }),
      );
    await message(post, 1, [{ kind: "ask", text: "Old", status: "answered", answer: "allow" }]);
    const current = await message(post, 2, [
      { kind: "text", text: "Here is the draft." },
      {
        kind: "ask",
        text: "Post on LinkedIn?",
        approvalEffectId: "effect-1",
        status: "pending",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    ]);
    await system.run.update({
      where: { id: post.run.id },
      data: { updatedAt: new Date(Date.now() - 60_000) },
    });

    const approvals = await listApprovals(system, ada);
    expect(approvals.map((entry) => [entry.bot.name, entry.ask?.block.text ?? null])).toEqual([
      ["Poster", "Post on LinkedIn?"],
      ["Screen", null],
    ]);
    expect(approvals[0]).toMatchObject({
      runId: post.run.id,
      spaceName: "Personal",
      groupId: null,
      ask: { messageId: current.id },
    });

    await system.run.update({ where: { id: post.run.id }, data: { status: "running" } });
    await expect(listApprovals(system, ada)).resolves.toHaveLength(1);
  });

  it("names the bot that handed a waiting run its work", async () => {
    const ada = await person();
    const manager = await botRun(ada, "Manager", "completed");
    const worker = await botRun(ada, "Worker", "waiting_input");
    const delivery = await runAsTenant(ada, () =>
      prisma.message.create({
        data: {
          threadId: worker.bot.threadId,
          seq: 1,
          role: "user",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: manager.bot.id,
              fromBotName: "Manager",
              text: "Publish the replies",
            },
          ] as object[],
        },
      }),
    );
    await system.run.update({
      where: { id: worker.run.id },
      data: { trigger: "bot_message", sourceMessageId: delivery.id },
    });

    const approvals = await listApprovals(system, ada);
    expect(approvals.map((entry) => [entry.bot.name, entry.requestedByBotId])).toEqual([
      ["Worker", manager.bot.id],
    ]);
  });

  it("shows finished and failed work as unread until the person has seen it", async () => {
    const ada = await person();
    const done = await botRun(ada, "Writer", "completed");
    await record(ada, done, "completion");
    await record(ada, done, "failure");

    let inbox = await listInbox(system, ada);
    expect(inbox.recent.map((entry) => [entry.kind, entry.read])).toEqual([
      ["failure", false],
      ["completion", false],
    ]);
    expect(inbox.unread).toBe(2);

    await markInboxRead(system, ada);
    inbox = await listInbox(system, ada);
    expect(inbox.unread).toBe(0);
    expect(inbox.recent.every((entry) => entry.read)).toBe(true);
  });

  it("keeps each person's bell to themselves and to the organization it is for", async () => {
    const ada = await person();
    const grace = await person();
    const theirs = await botRun(grace, "Theirs", "waiting_input");
    await record(grace, theirs, "completion");

    const work = await createOrganizationForUser(system, { userId: ada.userId, name: "Work" });
    const elsewhere = await botRun(
      { userId: ada.userId, spaceId: work.defaultSpaceId },
      "Work bot",
      "waiting_input",
    );
    await record({ userId: ada.userId, spaceId: work.defaultSpaceId }, elsewhere, "completion");

    await expect(listInbox(system, ada)).resolves.toEqual({ needsYou: [], recent: [], unread: 0 });
    const atWork = await listInbox(system, { userId: ada.userId, organizationId: work.id });
    expect(atWork.needsYou.map((entry) => entry.bot.name)).toEqual(["Work bot"]);
    expect(atWork.recent).toHaveLength(1);

    // Marking read touches only the person's own rows in that organization.
    await markInboxRead(system, { userId: ada.userId, organizationId: grace.organizationId });
    await expect(listInbox(system, grace)).resolves.toMatchObject({ unread: 1 });
  });
});
