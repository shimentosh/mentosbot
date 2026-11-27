import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Team, TeamRole } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Share, StyleSheet } from "react-native";
import { NativeSymbol } from "../../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { useLiveStream } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import {
  native,
  useMobileTokens,
  useResolvedAppearance,
  useThemedStyles,
} from "../../lib/native/native";
import { targetRpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { refreshOrganizations } from "../../lib/spaces/organizations";

type Member = Team["members"][number];
type Invitation = Team["invitations"][number];
type Change =
  | { kind: "invite"; email: string }
  | { kind: "resend"; invitation: Invitation }
  | { kind: "role"; member: Member; role: "admin" | "member" }
  | { kind: "remove"; member: Member }
  | { kind: "revoke"; invitation: Invitation };

/** Mirrors the server's rule: owners manage everyone else, admins manage members. */
function canManage(viewer: TeamRole, target: TeamRole): boolean {
  if (target === "owner") return false;
  return viewer === "owner" || (viewer === "admin" && target === "member");
}

/** Everyone on the team; its owner and admins also invite, open a member, and remove. */
export default function OrganizationMembersScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const { organizationId } = useLocalSearchParams<{ organizationId: string }>();
  const read = targetRpcQuery(ACCOUNT_SETTINGS, "team/get", { organizationId });
  const query = useScreenQuery(read, { enabled: Boolean(organizationId) });
  // Someone else's change to the members reaches this screen as a signal on the live stream.
  useLiveStream(useIsFocused());
  const team = query.data ?? null;
  const [email, setEmail] = useState("");
  const loadError =
    query.error && !query.isFetching ? errorText(query.error, t`Could not load members`) : null;

  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (ask: Change, send) => {
      if (ask.kind === "invite" || ask.kind === "resend") {
        const invited = await send("team/invite", {
          organizationId,
          email: ask.kind === "invite" ? ask.email : ask.invitation.email,
          role: ask.kind === "invite" ? "member" : ask.invitation.role,
        });
        await refreshOrganizations();
        return invited;
      }
      if (ask.kind === "revoke") {
        await send("team/revokeInvitation", { invitationId: ask.invitation.id });
      } else if (ask.kind === "remove") {
        await send("team/remove", { organizationId, userId: ask.member.userId });
      } else {
        await send("team/setRole", { organizationId, userId: ask.member.userId, role: ask.role });
      }
      // The member count shows on the Organization screen.
      await refreshOrganizations();
      return null;
    },
    stale: [read.queryKey],
    onSaved: async (sent, ask) => {
      if (ask.kind === "invite") setEmail("");
      // Without an email from this server, the link goes to them by hand.
      if (sent && !sent.emailSent) await shareLink(sent.url);
    },
    onFailed: (err, ask) =>
      Alert.alert(
        ask.kind === "invite" || ask.kind === "resend"
          ? t`Could not invite`
          : ask.kind === "remove"
            ? t`Could not remove member`
            : ask.kind === "revoke"
              ? t`Could not cancel invitation`
              : t`Could not change role`,
        errorText(err, t`Try again.`),
      ),
  });

  async function shareLink(url: string) {
    // iOS shares a URL as a link; Android only takes text.
    await Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch((err: unknown) =>
      Alert.alert(t`Could not share invite link`, errorText(err, t`Try again.`)),
    );
  }

  function invite() {
    const address = email.trim();
    if (address && !change.pending) change.run({ kind: "invite", email: address });
  }

  function confirmRemove(member: Member, label: string) {
    Alert.alert(t`Remove ${ph({ name: label })}?`, t`Their bots pass to you.`, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Remove`,
        style: "destructive",
        onPress: () => change.run({ kind: "remove", member }),
      },
    ]);
  }

  const viewer = team?.role ?? "member";
  const canInvite = viewer !== "member";
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
    >
      {loadError ? <LoadFailure message={loadError} onRetry={() => void query.refetch()} /> : null}
      {!team && !loadError ? <ActivityIndicator color={native.secondaryLabel} /> : null}
      {canInvite ? (
        <SettingsGroup>
          <SettingsInputRow
            key="email"
            accessibilityLabel={t`Email`}
            placeholder={t`Email`}
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="send"
            editable={!change.pending}
            value={email}
            onChangeText={setEmail}
            onSubmitEditing={invite}
          />
          <SettingsRow
            key="invite"
            title={t`Invite`}
            tinted
            leading={
              <NativeSymbol
                ios="person.badge.plus"
                android="person-add-outline"
                color={tokens.link}
              />
            }
            disabled={change.pending || !email.trim()}
            dimmed={!email.trim()}
            accessibilityRole="button"
            onPress={invite}
          />
        </SettingsGroup>
      ) : null}
      {team ? (
        <SettingsGroup accessibilityLabel={t`Members`}>
          {team.members.map((member) => {
            const display = accountDisplay(member, member.email);
            const roleLabel =
              member.role === "owner" ? t`Owner` : member.role === "admin" ? t`Admin` : undefined;
            if (!canManage(viewer, member.role))
              return (
                <SettingsRow
                  key={member.userId}
                  title={display.label}
                  detail={display.label === member.email ? undefined : member.email}
                  value={roleLabel}
                />
              );
            const roleTitle = member.role === "admin" ? t`Make member` : t`Make admin`;
            const nextRole = member.role === "admin" ? "member" : "admin";
            const roleChangeable = viewer === "owner";
            const open = () =>
              router.push({
                pathname: "/organization-member",
                params: { organizationId, userId: member.userId, name: display.label },
              });
            return (
              <MenuView
                key={member.userId}
                shouldOpenOnLongPress
                colorScheme={appearance}
                actions={[
                  ...(roleChangeable
                    ? [{ id: "role", title: roleTitle, image: "person.badge.key" as const }]
                    : []),
                  {
                    id: "remove",
                    title: t`Remove`,
                    image: "person.badge.minus" as const,
                    attributes: { destructive: true },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "remove") confirmRemove(member, display.label);
                  else change.run({ kind: "role", member, role: nextRole });
                }}
              >
                <SettingsRow
                  title={display.label}
                  detail={display.label === member.email ? undefined : member.email}
                  value={roleLabel}
                  chevron="right"
                  accessibilityRole="button"
                  accessibilityHint={t`Opens their bots and usage`}
                  onPress={open}
                  accessibilityActions={[
                    ...(roleChangeable ? [{ name: "role", label: roleTitle }] : []),
                    { name: "remove", label: t`Remove` },
                  ]}
                  onAccessibilityAction={({ nativeEvent }) => {
                    if (nativeEvent.actionName === "remove") confirmRemove(member, display.label);
                    else change.run({ kind: "role", member, role: nextRole });
                  }}
                />
              </MenuView>
            );
          })}
          {team.invitations.map((invitation) => (
            <MenuView
              key={invitation.id}
              shouldOpenOnLongPress
              colorScheme={appearance}
              actions={[
                { id: "share", title: t`Share invite link`, image: "square.and.arrow.up" },
                { id: "resend", title: t`Send a new link`, image: "arrow.clockwise" },
                {
                  id: "revoke",
                  title: t`Cancel invitation`,
                  image: "xmark",
                  attributes: { destructive: true },
                },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "revoke") change.run({ kind: "revoke", invitation });
                else if (nativeEvent.event === "resend") change.run({ kind: "resend", invitation });
                else void shareLink(invitation.url);
              }}
            >
              <SettingsRow
                title={invitation.email}
                value={t`Invited`}
                accessibilityActions={[
                  { name: "share", label: t`Share invite link` },
                  { name: "resend", label: t`Send a new link` },
                  { name: "revoke", label: t`Cancel invitation` },
                ]}
                onAccessibilityAction={({ nativeEvent }) => {
                  if (nativeEvent.actionName === "revoke")
                    change.run({ kind: "revoke", invitation });
                  else if (nativeEvent.actionName === "resend")
                    change.run({ kind: "resend", invitation });
                  else void shareLink(invitation.url);
                }}
              />
            </MenuView>
          ))}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
  });
}
