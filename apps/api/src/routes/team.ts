import { ORPCError } from "@orpc/server";
import { archiveBot } from "@rakazo/adapters";
import { emailLocale, teamInviteEmail } from "@rakazo/auth";
import {
  AlreadyTeamMemberError,
  acceptTeamInvitation,
  InvalidInvitationEmailError,
  InvitationLimitError,
  InvitationUnavailableError,
  inviteToTeam,
  listDepartingMemberBots,
  listTeam,
  previewTeamInvitation,
  recordAuditEvent,
  removeTeamMember,
  revokeTeamInvitation,
  runAsSystem,
  runAsTenant,
  setTeamMemberRole,
  TeamPermissionError,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

export function teamRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const lifecycle = {
    prisma: deps.prisma,
    sandbox: deps.sandbox,
    home: deps.home,
    jobs: deps.jobs,
    artifacts: deps.artifacts,
    dataDir: deps.dataDir,
  };
  return {
    team: {
      get: authed.team.get.handler(({ context, input }) =>
        runAsSystem("list a team's members", async () => {
          const team = await mapTeamError(
            listTeam(deps.prisma, {
              userId: context.actor.userId,
              organizationId: input.organizationId,
            }),
          );
          return {
            organizationId: input.organizationId,
            role: team.role,
            members: team.members.map((member) => ({
              ...member,
              joinedAt: member.joinedAt.toISOString(),
            })),
            invitations: team.invitations.map((invitation) => ({
              ...invitation,
              expiresAt: invitation.expiresAt.toISOString(),
            })),
          };
        }),
      ),
      invite: authed.team.invite.handler(({ context, input }) =>
        runAsSystem("invite someone to a team", async () => {
          const invitation = await mapTeamError(
            inviteToTeam(deps.prisma, {
              userId: context.actor.userId,
              organizationId: input.organizationId,
              email: input.email,
              role: input.role,
            }),
          );
          await recordAuditEvent({
            action: "team.member.invited",
            actor: { type: "user", id: context.actor.userId },
            organizationId: input.organizationId,
            target: { type: "invitation", id: invitation.id, label: invitation.email },
            metadata: { role: invitation.role },
          });
          let emailSent = false;
          if (deps.email) {
            try {
              const invitee = await deps.prisma.user.findUnique({
                where: { email: invitation.email },
                select: { locale: true },
              });
              const message = await teamInviteEmail(
                {
                  email: invitation.email,
                  inviterName: invitation.inviterName || context.actor.email,
                  teamName: invitation.organizationName,
                },
                new URL(
                  `/invite/${encodeURIComponent(invitation.id)}`,
                  deps.env.webOrigin,
                ).toString(),
                emailLocale(invitee?.locale),
              );
              await deps.email.send(message);
              emailSent = true;
            } catch (error) {
              deps.onEmailError?.(error);
            }
          }
          return { id: invitation.id, emailSent };
        }),
      ),
      revokeInvitation: authed.team.revokeInvitation.handler(({ context, input }) =>
        runAsSystem("revoke a team invitation", async () => {
          const revoked = await mapTeamError(
            revokeTeamInvitation(deps.prisma, {
              userId: context.actor.userId,
              invitationId: input.invitationId,
            }),
          );
          await recordAuditEvent({
            action: "team.invitation.revoked",
            actor: { type: "user", id: context.actor.userId },
            organizationId: revoked.organizationId,
            target: { type: "invitation", id: input.invitationId, label: revoked.email },
          });
          return { ok: true as const };
        }),
      ),
      invitation: authed.team.invitation.handler(({ context, input }) =>
        runAsSystem("show an invitation to the invited account", () =>
          mapTeamError(
            previewTeamInvitation(deps.prisma, {
              userId: context.actor.userId,
              invitationId: input.invitationId,
              requireVerifiedEmail: Boolean(deps.email),
            }),
          ),
        ),
      ),
      accept: authed.team.accept.handler(({ context, input }) =>
        runAsSystem("join a team from an invitation", async () => {
          const joined = await mapTeamError(
            acceptTeamInvitation(deps.prisma, {
              userId: context.actor.userId,
              invitationId: input.invitationId,
              requireVerifiedEmail: Boolean(deps.email),
            }),
          );
          await recordAuditEvent({
            action: "team.member.joined",
            actor: { type: "user", id: context.actor.userId },
            organizationId: joined.organizationId,
            target: { type: "user", id: context.actor.userId, label: context.actor.email },
            metadata: { role: joined.role },
          });
          return { organizationId: joined.organizationId, defaultSpaceId: joined.defaultSpaceId };
        }),
      ),
      setRole: authed.team.setRole.handler(({ context, input }) =>
        runAsSystem("change a team member's role", async () => {
          const { previousRole } = await mapTeamError(
            setTeamMemberRole(deps.prisma, {
              userId: context.actor.userId,
              organizationId: input.organizationId,
              memberUserId: input.userId,
              role: input.role,
            }),
          );
          await recordAuditEvent({
            action: "team.member.role_changed",
            actor: { type: "user", id: context.actor.userId },
            organizationId: input.organizationId,
            target: { type: "user", id: input.userId },
            metadata: { from: previousRole, to: input.role },
          });
          return { ok: true as const };
        }),
      ),
      remove: authed.team.remove.handler(({ context, input }) =>
        runAsSystem("remove a team member", async () => {
          const target = {
            userId: context.actor.userId,
            organizationId: input.organizationId,
            memberUserId: input.userId,
          };
          // Stop the member's work in the team before their access ends: archiving cancels
          // runs and routines and stops computers, and keeps the bots for the owner.
          const bots = await mapTeamError(listDepartingMemberBots(deps.prisma, target));
          for (const bot of bots) {
            if (bot.archivedAt) continue;
            await runAsTenant({ spaceId: bot.spaceId, userId: bot.userId }, () =>
              archiveBot(
                lifecycle,
                bot,
                computerContext(
                  { spaceId: bot.spaceId, userId: bot.userId },
                  bot.id,
                  "team-remove",
                ),
              ),
            );
          }
          const { role } = await mapTeamError(removeTeamMember(deps.prisma, target));
          await recordAuditEvent({
            action:
              input.userId === context.actor.userId ? "team.member.left" : "team.member.removed",
            actor: { type: "user", id: context.actor.userId },
            organizationId: input.organizationId,
            target: { type: "user", id: input.userId },
            metadata: { role, archivedBots: bots.filter((bot) => !bot.archivedAt).length },
          });
          return { ok: true as const };
        }),
      ),
    },
  };
}

async function mapTeamError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof TeamPermissionError)
      throw new ORPCError("FORBIDDEN", { message: error.message });
    if (error instanceof InvitationUnavailableError)
      throw new ORPCError("NOT_FOUND", { message: error.message });
    if (
      error instanceof AlreadyTeamMemberError ||
      error instanceof InvalidInvitationEmailError ||
      error instanceof InvitationLimitError
    )
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    throw error;
  }
}
