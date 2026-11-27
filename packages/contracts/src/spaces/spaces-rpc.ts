import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { groupId } from "../rpc/inputs.js";
import { SpaceSettingSchema } from "../settings-scope.js";
import { ThreadMessagePageSchema } from "../threads/thread.js";
import { CreateGroupInput, GroupDetailSchema, GroupSchema, UpdateGroupInput } from "./groups.js";
import {
  BotAccessEntrySchema,
  BotAccessLevelSchema,
  GrantableBotSchema,
  InvitableTeamRoleSchema,
  InvitationBotGrantSchema,
  OrganizationInvitationPreviewSchema,
  OrganizationListSchema,
  OrganizationMembersSchema,
  OrganizationRoleSchema,
  TeamBotSchema,
  TeamSchema,
  TeamUsagePeriodSchema,
  TeamUsageRowSchema,
} from "./organization.js";
import {
  SpaceInviteLinkSchema,
  SpaceInvitePreviewSchema,
  SpaceMembersSchema,
  SpaceNavigationSchema,
  SpaceSchema,
} from "./space.js";

const spaceName = z.string().trim().min(1).max(60);
const organizationName = spaceName;
const invitationId = z.string().min(20).max(200);

export const spacesRpc = {
  spaces: {
    list: oc.output(SpaceNavigationSchema),
    create: oc.input(z.object({ name: spaceName })).output(SpaceSchema),
    rename: oc
      .input(z.object({ spaceId: Id, name: spaceName }))
      .output(z.object({ id: Id, name: z.string() })),
    remove: oc
      .input(z.object({ spaceId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    members: {
      list: oc.input(z.object({ spaceId: Id })).output(SpaceMembersSchema),
      /** Owner only. Adds someone already in the Space's organization. */
      add: oc
        .input(z.object({ spaceId: Id, userId: Id }))
        .output(z.object({ ok: z.literal(true) })),
      /** Owner only. The removed person's bots, chats and routines stay with the space. */
      remove: oc
        .input(z.object({ spaceId: Id, userId: Id }))
        .output(z.object({ ok: z.literal(true) })),
      /** Members only; an owner deletes the space instead. */
      leave: oc
        .input(z.object({ spaceId: Id }))
        .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    },
    invites: {
      /**
       * Owner only. A new single-use link each call, emailed when an address is given. Whoever
       * joins from outside the organization is a guest in this Space alone.
       */
      create: oc
        .input(z.object({ spaceId: Id, email: z.email().max(254).optional() }))
        .output(SpaceInviteLinkSchema),
      preview: oc
        .input(z.object({ token: z.string().min(1).max(200) }))
        .output(SpaceInvitePreviewSchema),
      accept: oc
        .input(z.object({ token: z.string().min(1).max(200) }))
        .output(z.object({ spaceId: Id })),
      /** Owner only. Every unused link stops working, for one that went to the wrong place. */
      cancel: oc.input(z.object({ spaceId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  organizations: {
    list: oc.output(OrganizationListSchema),
    create: oc
      .input(z.object({ name: organizationName }))
      .output(z.object({ id: Id, name: z.string(), defaultSpaceId: Id })),
    rename: oc
      .input(z.object({ organizationId: Id, name: organizationName }))
      .output(z.object({ id: Id, name: z.string() })),
    remove: oc
      .input(z.object({ organizationId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    members: {
      list: oc.input(z.object({ organizationId: Id })).output(OrganizationMembersSchema),
      /** Owner and admins. The owner's role never changes. */
      setRole: oc
        .input(
          z.object({
            organizationId: Id,
            userId: Id,
            role: OrganizationRoleSchema.exclude(["owner"]),
          }),
        )
        .output(z.object({ ok: z.literal(true) })),
      /** Owner and admins. What the person made in shared Spaces stays there. */
      remove: oc
        .input(z.object({ organizationId: Id, userId: Id }))
        .output(z.object({ ok: z.literal(true) })),
    },
    invitations: {
      /** Owner and admins. Inviting the same address again renews its invitation. */
      create: oc
        .input(z.object({ organizationId: Id, email: z.email().max(254) }))
        .output(z.object({ url: z.string().url(), emailed: z.boolean() })),
      cancel: oc
        .input(z.object({ organizationId: Id, invitationId: Id }))
        .output(z.object({ ok: z.literal(true) })),
      /** The invited person, signed in with the address it went to. */
      preview: oc.input(z.object({ invitationId: Id })).output(OrganizationInvitationPreviewSchema),
      accept: oc.input(z.object({ invitationId: Id })).output(z.object({ spaceId: Id })),
    },
  },
  /** People in the current organization, and invitations to join it. */
  team: {
    get: oc.input(z.object({ organizationId: Id })).output(TeamSchema),
    invite: oc
      .input(
        z.object({
          organizationId: Id,
          email: z.string().trim().toLowerCase().max(254).email(),
          role: InvitableTeamRoleSchema,
          /** Bots they get on joining. Left out, renewing an invitation keeps its bots. */
          bots: z.array(InvitationBotGrantSchema).max(200).optional(),
        }),
      )
      .output(z.object({ id: z.string(), emailSent: z.boolean() })),
    revokeInvitation: oc
      .input(z.object({ invitationId }))
      .output(z.object({ ok: z.literal(true) })),
    /** The invitation as its invited, verified account sees it before joining. */
    invitation: oc.input(z.object({ invitationId })).output(
      z.object({
        organizationName: z.string(),
        inviterName: z.string(),
        role: InvitableTeamRoleSchema,
      }),
    ),
    accept: oc
      .input(z.object({ invitationId }))
      .output(z.object({ organizationId: Id, defaultSpaceId: Id })),
    setRole: oc
      .input(z.object({ organizationId: Id, userId: Id, role: InvitableTeamRoleSchema }))
      .output(z.object({ ok: z.literal(true) })),
    /** Teammates' bots in the current Space, for its team's owner; empty for anyone else. */
    bots: oc.output(z.array(TeamBotSchema)),
    /** A page of a teammate's bot's chat, or a teammate's chat with a shared bot, read only, for the team's owner. */
    botMessages: oc
      .input(
        z.object({
          botId: Id,
          /** Reads this teammate's own chat with the bot instead of the bot's main chat. */
          memberUserId: Id.optional(),
          before: z.number().int().nonnegative().optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    /**
     * The bots the signed-in person may hand out on a team, with what a member already has; without
     * a member, those an invitation can include.
     */
    grantableBots: oc
      .input(z.object({ organizationId: Id, userId: Id.optional() }))
      .output(z.array(GrantableBotSchema)),
    /** Model spend by person and bot across the team, for its owner only. */
    usage: oc
      .input(z.object({ organizationId: Id, period: TeamUsagePeriodSchema }))
      .output(z.array(TeamUsageRowSchema)),
    /** Who a bot is shared with, for its owner or someone who manages it. */
    botAccess: oc.input(z.object({ botId: Id })).output(z.array(BotAccessEntrySchema)),
    shareBot: oc
      .input(z.object({ botId: Id, userId: Id, level: BotAccessLevelSchema }))
      .output(z.array(BotAccessEntrySchema)),
    /** Stops sharing a bot with someone, or, for one's own id, gives it back. */
    unshareBot: oc
      .input(z.object({ botId: Id, userId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    /** Removes a member, or, for one's own id, leaves the team. */
    remove: oc
      .input(z.object({ organizationId: Id, userId: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  groups: {
    create: oc.input(CreateGroupInput).output(GroupSchema),
    list: oc.output(z.array(GroupSchema)),
    listArchived: oc.output(z.array(GroupSchema)),
    get: oc.input(groupId).output(GroupDetailSchema),
    duplicate: oc.input(groupId).output(GroupSchema),
    update: oc.input(UpdateGroupInput).output(GroupSchema),
    archive: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
  },
  /** Which account settings the bound Space overrides for the member. */
  spaceSettings: {
    overrides: oc.output(z.array(SpaceSettingSchema)),
    /** Customizing copies the account's settings into the Space; ending it drops the copy. */
    setOverride: oc
      .input(z.object({ setting: SpaceSettingSchema, enabled: z.boolean() }))
      .output(z.array(SpaceSettingSchema)),
  },
};
