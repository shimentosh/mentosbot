import { randomBytes } from "node:crypto";
import { isMessagingEmail } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type TeamRole = "owner" | "admin" | "member";
export type InvitableRole = Exclude<TeamRole, "owner">;

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITATIONS = 50;
/** Invitations a team may send a day, so a compromised admin can't use it to send spam. */
export const MAX_DAILY_INVITATIONS = 100;

/** The signed-in member may not make this change in their organization. */
export class TeamPermissionError extends Error {
  constructor(message = "You can't change this team") {
    super(message);
    this.name = "TeamPermissionError";
  }
}

/** One error for missing, expired, used and someone else's invitations, so none can be told apart. */
export class InvitationUnavailableError extends Error {
  constructor() {
    super("This invitation is no longer available");
    this.name = "InvitationUnavailableError";
  }
}

export class InvalidInvitationEmailError extends Error {
  constructor() {
    super("Enter a valid email address");
    this.name = "InvalidInvitationEmailError";
  }
}

export class AlreadyTeamMemberError extends Error {
  constructor() {
    super("This person is already on the team");
    this.name = "AlreadyTeamMemberError";
  }
}

export class InvitationLimitError extends Error {
  constructor() {
    super("This team has sent too many invitations. Try again later.");
    this.name = "InvitationLimitError";
  }
}

/** Better Auth stores roles comma-separated; the strongest one decides. */
export function teamRole(raw: string): TeamRole {
  const roles = raw.split(",").map((role) => role.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

const LIVE: Prisma.OrganizationWhereInput = {
  spaces: { some: { isDefault: true, deletingAt: null } },
};

type Db = PrismaClient | Prisma.TransactionClient;

async function requireTeamRole(
  db: Db,
  input: { userId: string; organizationId: string },
): Promise<TeamRole> {
  const member = await db.member.findFirst({
    where: { userId: input.userId, organizationId: input.organizationId, organization: LIVE },
    select: { role: true },
  });
  if (!member) throw new IsolationError();
  return teamRole(member.role);
}

/** Owners manage everyone; admins manage members only. Nobody manages an owner here. */
function canManage(actor: TeamRole, target: TeamRole): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  return actor === "admin" && target === "member";
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new InvalidInvitationEmailError();
  if (isMessagingEmail(normalized)) throw new InvalidInvitationEmailError();
  return normalized;
}

async function lockTeam(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`team:${organizationId}`}, 0))::text AS "lock"
  `);
}

export interface TeamMemberRow {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
  joinedAt: Date;
}

export interface TeamInvitationRow {
  id: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
}

/** The team's members for any member; pending invitations only for those who manage it. */
export async function listTeam(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<{ role: TeamRole; members: TeamMemberRow[]; invitations: TeamInvitationRow[] }> {
  const role = await requireTeamRole(prisma, input);
  const [members, invitations] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId: input.organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),
    role === "member"
      ? Promise.resolve([])
      : prisma.invitation.findMany({
          where: {
            organizationId: input.organizationId,
            status: "pending",
            expiresAt: { gt: new Date() },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, email: true, role: true, expiresAt: true },
        }),
  ]);
  return {
    role,
    members: members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: teamRole(member.role),
      joinedAt: member.createdAt,
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: teamRole(invitation.role ?? "member") === "admin" ? "admin" : "member",
      expiresAt: invitation.expiresAt,
    })),
  };
}

/**
 * Invites an email to the team, replacing any pending invitation for it so only the newest link
 * works. The invitation id is the unguessable link token; accepting also needs an account with
 * the invited email, so a leaked link alone admits nobody.
 */
export async function inviteToTeam(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; email: string; role: InvitableRole },
): Promise<TeamInvitationRow & { organizationName: string; inviterName: string }> {
  const email = normalizeEmail(input.email);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockTeam(tx, input.organizationId);
      const actorRole = await requireTeamRole(tx, input);
      if (!canManage(actorRole, input.role)) throw new TeamPermissionError();
      const existing = await tx.member.count({
        where: {
          organizationId: input.organizationId,
          user: { email: { equals: email, mode: "insensitive" } },
        },
      });
      if (existing > 0) throw new AlreadyTeamMemberError();
      const now = new Date();
      await tx.invitation.updateMany({
        where: {
          organizationId: input.organizationId,
          email,
          status: "pending",
        },
        data: { status: "canceled" },
      });
      const pending = await tx.invitation.count({
        where: { organizationId: input.organizationId, status: "pending", expiresAt: { gt: now } },
      });
      const sentToday = await tx.invitation.count({
        where: {
          organizationId: input.organizationId,
          createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
      });
      if (pending >= MAX_PENDING_INVITATIONS || sentToday >= MAX_DAILY_INVITATIONS)
        throw new InvitationLimitError();
      const [organization, inviter] = await Promise.all([
        tx.organization.findUniqueOrThrow({
          where: { id: input.organizationId },
          select: { name: true },
        }),
        tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { name: true } }),
      ]);
      const invitation = await tx.invitation.create({
        data: {
          id: randomBytes(32).toString("base64url"),
          organizationId: input.organizationId,
          email,
          role: input.role,
          status: "pending",
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
          inviterId: input.userId,
        },
        select: { id: true, email: true, expiresAt: true },
      });
      return {
        ...invitation,
        role: input.role,
        organizationName: organization.name,
        inviterName: inviter.name,
      };
    }),
  );
}

export async function revokeTeamInvitation(
  prisma: PrismaClient,
  input: { userId: string; invitationId: string },
): Promise<{ organizationId: string; email: string }> {
  return prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { id: input.invitationId },
      select: { organizationId: true, email: true, role: true, status: true },
    });
    if (!invitation) throw new IsolationError();
    const actorRole = await requireTeamRole(tx, {
      userId: input.userId,
      organizationId: invitation.organizationId,
    });
    const invitedRole = teamRole(invitation.role ?? "member");
    if (!canManage(actorRole, invitedRole)) throw new TeamPermissionError();
    await tx.invitation.updateMany({
      where: { id: input.invitationId, status: "pending" },
      data: { status: "canceled" },
    });
    return { organizationId: invitation.organizationId, email: invitation.email };
  });
}

interface OpenInvitationInput {
  userId: string;
  invitationId: string;
  /**
   * Whether the account must have proved its mailbox. Servers that send email do; without
   * email, the link the inviter passed on and the matching address are the proof.
   */
  requireVerifiedEmail: boolean;
}

async function openInvitation(
  db: Db,
  input: OpenInvitationInput,
): Promise<{ organizationId: string; role: InvitableRole; inviterId: string }> {
  const [invitation, user] = await Promise.all([
    db.invitation.findUnique({
      where: { id: input.invitationId },
      select: {
        organizationId: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        inviterId: true,
        organization: {
          select: {
            spaces: { where: { isDefault: true, deletingAt: null }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    db.user.findUnique({
      where: { id: input.userId },
      select: { email: true, emailVerified: true },
    }),
  ]);
  if (
    !invitation ||
    !user ||
    invitation.status !== "pending" ||
    invitation.expiresAt <= new Date() ||
    invitation.organization.spaces.length === 0 ||
    (input.requireVerifiedEmail && !user.emailVerified) ||
    user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()
  )
    throw new InvitationUnavailableError();
  return {
    organizationId: invitation.organizationId,
    role: teamRole(invitation.role ?? "member") === "admin" ? "admin" : "member",
    inviterId: invitation.inviterId,
  };
}

/** What the invited person sees before accepting. Anyone else gets the same unavailable error. */
export async function previewTeamInvitation(
  prisma: PrismaClient,
  input: OpenInvitationInput,
): Promise<{ organizationName: string; inviterName: string; role: InvitableRole }> {
  const invitation = await openInvitation(prisma, input);
  const [organization, inviter] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: invitation.organizationId },
      select: { name: true },
    }),
    prisma.user.findUnique({ where: { id: invitation.inviterId }, select: { name: true } }),
  ]);
  return {
    organizationName: organization.name,
    inviterName: inviter?.name ?? "",
    role: invitation.role,
  };
}

/**
 * Joins the invited team. Membership in the default Space comes from the database trigger on
 * `member`, so a joined member can always open the team.
 */
export async function acceptTeamInvitation(
  prisma: PrismaClient,
  input: OpenInvitationInput,
): Promise<{ organizationId: string; defaultSpaceId: string; role: InvitableRole }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const peek = await tx.invitation.findUnique({
        where: { id: input.invitationId },
        select: { organizationId: true },
      });
      if (!peek) throw new InvitationUnavailableError();
      await lockTeam(tx, peek.organizationId);
      const invitation = await openInvitation(tx, input);
      const claimed = await tx.invitation.updateMany({
        where: { id: input.invitationId, status: "pending" },
        data: { status: "accepted" },
      });
      if (claimed.count !== 1) throw new InvitationUnavailableError();
      const existing = await tx.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId: input.userId,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        await tx.member.create({
          data: {
            id: randomBytes(16).toString("hex"),
            organizationId: invitation.organizationId,
            userId: input.userId,
            role: invitation.role,
            createdAt: new Date(),
          },
        });
      }
      const space = await tx.space.findFirstOrThrow({
        where: { organizationId: invitation.organizationId, isDefault: true },
        select: { id: true },
      });
      return {
        organizationId: invitation.organizationId,
        defaultSpaceId: space.id,
        role: invitation.role,
      };
    }),
  );
}

export async function setTeamMemberRole(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; memberUserId: string; role: InvitableRole },
): Promise<{ previousRole: TeamRole }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockTeam(tx, input.organizationId);
      const actorRole = await requireTeamRole(tx, input);
      // Promoting and demoting admins is the owner's call alone.
      if (actorRole !== "owner") throw new TeamPermissionError();
      const target = await tx.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: input.memberUserId,
          },
        },
        select: { id: true, role: true },
      });
      if (!target) throw new IsolationError();
      const previousRole = teamRole(target.role);
      if (previousRole === "owner") throw new TeamPermissionError();
      await tx.member.update({ where: { id: target.id }, data: { role: input.role } });
      // The trigger copied the team role into the default Space; keep it in step there.
      await tx.spaceMember.updateMany({
        where: {
          organizationId: input.organizationId,
          userId: input.memberUserId,
          space: { isDefault: true },
          role: { in: ["admin", "member"] },
        },
        data: { role: input.role },
      });
      return { previousRole };
    }),
  );
}

/** Bots a departing member leaves in the team, for the caller to archive before removal. */
export async function listDepartingMemberBots(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; memberUserId: string },
) {
  const actorRole = await requireTeamRole(prisma, input);
  const targetRole = await requireTeamRole(prisma, {
    userId: input.memberUserId,
    organizationId: input.organizationId,
  });
  if (input.userId !== input.memberUserId && !canManage(actorRole, targetRole))
    throw new TeamPermissionError();
  if (targetRole === "owner") throw new TeamPermissionError();
  return prisma.bot.findMany({
    where: {
      userId: input.memberUserId,
      space: { organizationId: input.organizationId },
    },
    include: { thread: true, computer: true },
  });
}

/**
 * Removes a member, or lets one leave. Spaces the member made in the team pass to the owner, so
 * nothing in the team is left without someone who can manage it; the member's archived bots stay
 * for the owner to take over.
 */
export async function removeTeamMember(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; memberUserId: string },
): Promise<{ role: TeamRole }> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockTeam(tx, input.organizationId);
      const actorRole = await requireTeamRole(tx, input);
      const target = await tx.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: input.memberUserId,
          },
        },
        select: { id: true, role: true },
      });
      if (!target) throw new IsolationError();
      const role = teamRole(target.role);
      const leaving = input.userId === input.memberUserId;
      if (role === "owner" || (!leaving && !canManage(actorRole, role)))
        throw new TeamPermissionError();
      const owner = await tx.member.findFirstOrThrow({
        where: { organizationId: input.organizationId, role: { contains: "owner" } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { userId: true },
      });
      const ownedSpaces = await tx.spaceMember.findMany({
        where: {
          organizationId: input.organizationId,
          userId: input.memberUserId,
          role: "owner",
          space: { isDefault: false },
        },
        select: { spaceId: true },
      });
      const now = new Date();
      for (const { spaceId } of ownedSpaces) {
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId, userId: owner.userId } },
          create: {
            id: randomBytes(16).toString("hex"),
            spaceId,
            organizationId: input.organizationId,
            userId: owner.userId,
            role: "owner",
            createdAt: now,
          },
          update: { role: "owner" },
        });
      }
      // Space memberships go with the member row by cascade.
      await tx.member.delete({ where: { id: target.id } });
      await tx.session.updateMany({
        where: { userId: input.memberUserId, activeOrganizationId: input.organizationId },
        data: { activeOrganizationId: null },
      });
      return { role };
    }),
  );
}
