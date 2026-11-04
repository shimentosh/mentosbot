import { ORPCError } from "@orpc/server";
import { archiveBot } from "@rakazo/adapters";
import { emailLocale, teamInviteEmail } from "@rakazo/auth";
import {
  AlreadyTeamMemberError,
  acceptTeamInvitation,
  BotShareError,
  InvalidInvitationEmailError,
  InvitationLimitError,
  InvitationUnavailableError,
  inviteToTeam,
  listBotAccess,
  listDepartingMemberBots,
  listTeam,
  listTeamBots,
  previewTeamInvitation,
  recordAuditEvent,
  removeTeamMember,
  revokeTeamInvitation,
  runAsSystem,
  runAsTenant,
  setTeamMemberRole,
  shareBot,
  TeamPermissionError,
  teamBotForOwner,
  unshareBot,
} from "@rakazo/db";
import { loadMessagePage } from "../thread-message-pages.js";
import type { RouterContext } from "./context.js";
import { computerContext, THREAD_MESSAGE_PAGE_SIZE } from "./shared.js";

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
      bots: authed.team.bots.handler(({ context }) =>
        runAsSystem("list teammates' bots for the team's owner", async () =>
          (
            await listTeamBots(deps.prisma, {
              userId: context.actor.userId,
              spaceId: context.actor.spaceId,
            })
          ).map((bot) => ({
            ...bot,
            avatarSet: bot.avatarSet === "rakazo" ? ("rakazo" as const) : ("organic" as const),
            lastActivityAt: bot.lastActivityAt.toISOString(),
          })),
        ),
      ),
      botMessages: authed.team.botMessages.handler(async ({ context, input }) => {
        const bot = await runAsSystem("check the team's owner may read a teammate's bot", () =>
          teamBotForOwner(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: input.botId,
          }),
        );
        // Opening the chat is recorded, so overseeing a teammate's work is never silent.
        if (input.before === undefined)
          await recordAuditEvent({
            action: "team.bot.viewed",
            actor: { type: "user", id: context.actor.userId },
            spaceId: context.actor.spaceId,
            target: { type: "bot", id: bot.id, label: bot.name },
            metadata: { botOwner: bot.ownerUserId },
          });
        // The Space is the owner's own, so the tenant scope already reads its chats.
        return loadMessagePage(deps.prisma, bot.threadId, input.before, THREAD_MESSAGE_PAGE_SIZE);
      }),
      botAccess: authed.team.botAccess.handler(({ context, input }) =>
        runAsSystem("list who a bot is shared with", () =>
          listBotAccess(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: input.botId,
          }),
        ),
      ),
      shareBot: authed.team.shareBot.handler(({ context, input }) =>
        runAsSystem("share a bot with a teammate", async () => {
          const scope = { userId: context.actor.userId, spaceId: context.actor.spaceId };
          let bot: Awaited<ReturnType<typeof shareBot>>;
          try {
            bot = await shareBot(deps.prisma, {
              ...scope,
              botId: input.botId,
              memberUserId: input.userId,
              level: input.level,
            });
          } catch (error) {
            if (error instanceof BotShareError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            throw error;
          }
          await recordAuditEvent({
            action: "team.bot.shared",
            actor: { type: "user", id: context.actor.userId },
            spaceId: context.actor.spaceId,
            target: { type: "bot", id: bot.id, label: bot.name },
            metadata: { with: input.userId, level: input.level },
          });
          return listBotAccess(deps.prisma, { ...scope, botId: input.botId });
        }),
      ),
      unshareBot: authed.team.unshareBot.handler(({ context, input }) =>
        runAsSystem("stop sharing a bot with a teammate", async () => {
          const removed = await unshareBot(deps.prisma, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            botId: input.botId,
            memberUserId: input.userId,
          });
          if (removed)
            await recordAuditEvent({
              action: "team.bot.unshared",
              actor: { type: "user", id: context.actor.userId },
              spaceId: context.actor.spaceId,
              target: { type: "bot", id: input.botId },
              metadata: { with: input.userId },
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
