import * as z from "zod";
import { BotAvatarSetSchema } from "../bots/bot-avatar.js";
import { Id, IsoDate } from "../ids.js";
import { PersonSchema } from "./person.js";

/** The organization's one owner, admins who manage its members with them, and everyone else. */
export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationMemberSchema = PersonSchema.extend({
  role: OrganizationRoleSchema,
  /** Whether the viewer may remove them: never the owner or themselves. */
  manageable: z.boolean(),
  /** Whether the viewer may make them an admin or a member: not while their removal is unfinished. */
  roleChangeable: z.boolean(),
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const OrganizationInvitationSchema = z.object({
  id: Id,
  email: z.string(),
  /** The link to accept it, for sharing by hand when no email arrives. */
  url: z.string().url(),
  expiresAt: z.string(),
});
export type OrganizationInvitation = z.infer<typeof OrganizationInvitationSchema>;

export const OrganizationMembersSchema = z.object({
  members: z.array(OrganizationMemberSchema),
  /** Pending invitations; empty for someone who cannot manage members. */
  invitations: z.array(OrganizationInvitationSchema),
  /** True for the owner and admins: they invite, change roles and remove people. */
  canManage: z.boolean(),
});
export type OrganizationMembers = z.infer<typeof OrganizationMembersSchema>;

export const OrganizationInvitationPreviewSchema = z.object({
  organizationName: z.string(),
  inviterName: z.string(),
});
export type OrganizationInvitationPreview = z.infer<typeof OrganizationInvitationPreviewSchema>;

/** Every organization the signed-in user belongs to, and which one the current Space belongs to. */
export const OrganizationListSchema = z.object({
  activeOrganizationId: Id,
  organizations: z.array(
    z.object({
      id: Id,
      name: z.string(),
      /** Where the user lands in it: its default Space if they belong to it, else their own. */
      defaultSpaceId: Id,
      spaceIds: z.array(Id),
      /** Whether the user owns it, so can rename or delete it. */
      canManage: z.boolean(),
      role: OrganizationRoleSchema,
      /** Everyone in it but guests, the user included. */
      memberCount: z.number().int().positive(),
    }),
  ),
});
export type OrganizationList = z.infer<typeof OrganizationListSchema>;

export const TeamRoleSchema = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
export const InvitableTeamRoleSchema = z.enum(["admin", "member"]);
export type InvitableTeamRole = z.infer<typeof InvitableTeamRoleSchema>;

export const TeamSchema = z.object({
  organizationId: Id,
  /** The signed-in member's role, which decides what they may change. */
  role: TeamRoleSchema,
  members: z.array(
    z.object({
      userId: Id,
      name: z.string(),
      email: z.string(),
      role: TeamRoleSchema,
      joinedAt: IsoDate,
    }),
  ),
  /** Pending invitations, shown only to owners and admins. */
  invitations: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      role: InvitableTeamRoleSchema,
      expiresAt: IsoDate,
    }),
  ),
});
export type Team = z.infer<typeof TeamSchema>;

export const BotAccessLevelSchema = z.enum(["chat", "manage"]);
export type BotAccessLevel = z.infer<typeof BotAccessLevelSchema>;
export const BotAccessEntrySchema = z.object({
  userId: Id,
  name: z.string(),
  email: z.string(),
  level: BotAccessLevelSchema,
});
export type BotAccessEntry = z.infer<typeof BotAccessEntrySchema>;

/** A teammate's bot as the team's owner oversees it. */
export const TeamBotSchema = z.object({
  id: Id,
  name: z.string(),
  color: z.string(),
  avatarSet: BotAvatarSetSchema,
  owner: z.object({ userId: Id, name: z.string(), email: z.string() }),
  status: z.string(),
  lastActivityAt: IsoDate,
  archived: z.boolean(),
});
export type TeamBot = z.infer<typeof TeamBotSchema>;

/** A bot someone may hand out on their team, with what a given member already has. */
export const GrantableBotSchema = z.object({
  id: Id,
  name: z.string(),
  color: z.string(),
  avatarSet: BotAvatarSetSchema,
  /** The Space's name when it is not the team's default one. */
  spaceName: z.string().nullable(),
  level: BotAccessLevelSchema.nullable(),
});
export type GrantableBot = z.infer<typeof GrantableBotSchema>;

/** Model spend on a team by one person on one bot, for the team's owner. */
export const TeamUsageRowSchema = z.object({
  userId: Id,
  botId: Id.nullable(),
  botName: z.string().nullable(),
  costUsd: z.number(),
  totalTokens: z.number(),
  calls: z.number().int(),
  lastUsedAt: IsoDate,
});
export type TeamUsageRow = z.infer<typeof TeamUsageRowSchema>;
export const TeamUsagePeriodSchema = z.enum(["30d", "all"]);
export type TeamUsagePeriod = z.infer<typeof TeamUsagePeriodSchema>;

export const InvitationBotGrantSchema = z.object({ botId: Id, level: BotAccessLevelSchema });
export type InvitationBotGrant = z.infer<typeof InvitationBotGrantSchema>;
