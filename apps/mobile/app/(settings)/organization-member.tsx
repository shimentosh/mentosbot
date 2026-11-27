import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { BotAccessLevel, GrantableBot, TeamUsagePeriod } from "@rakazo/contracts";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet } from "react-native";
import { BotAvatar } from "../../components/bots/bot-avatar";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native/native";
import { targetRpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";

type Access = BotAccessLevel | "none";

/** One teammate: which bots they may use, and for the team's owner, how much they have used. */
export default function OrganizationMemberScreen() {
  const { t, i18n } = useLingui();
  const styles = useThemedStyles(createStyles);
  const appearance = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const { organizationId, userId } = useLocalSearchParams<{
    organizationId: string;
    userId: string;
  }>();
  const teamRead = targetRpcQuery(ACCOUNT_SETTINGS, "team/get", { organizationId });
  const team = useScreenQuery(teamRead, { enabled: Boolean(organizationId) }).data;
  const botsRead = targetRpcQuery(ACCOUNT_SETTINGS, "team/grantableBots", {
    organizationId,
    userId,
  });
  const botsQuery = useScreenQuery(botsRead, { enabled: Boolean(organizationId && userId) });
  const [period, setPeriod] = useState<TeamUsagePeriod>("30d");
  const owner = team?.role === "owner";
  const usageRead = targetRpcQuery(ACCOUNT_SETTINGS, "team/usage", { organizationId, period });
  const usage = useScreenQuery(usageRead, { enabled: Boolean(organizationId) && owner }).data;

  const access = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (ask: { bot: GrantableBot; level: BotAccessLevel | null }, send) => {
      if (ask.level) await send("team/shareBot", { botId: ask.bot.id, userId, level: ask.level });
      else await send("team/unshareBot", { botId: ask.bot.id, userId });
    },
    stale: [botsRead.queryKey],
    onFailed: (err) => Alert.alert(t`Could not change access`, errorText(err, t`Try again.`)),
  });

  const options: { value: Access; label: string }[] = [
    { value: "none", label: t`No access` },
    { value: "chat", label: t`Can chat` },
    { value: "manage", label: t`Can manage` },
  ];
  const levelOf = (bot: GrantableBot): Access =>
    (access.pending && access.input?.bot.id === bot.id ? access.input.level : bot.level) ?? "none";
  const usd = new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" });
  const count = new Intl.NumberFormat(i18n.locale, { notation: "compact" });
  const cost = (value: number) =>
    value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value);
  const rows = (usage ?? []).filter((row) => row.userId === userId);
  const total = rows.reduce(
    (sum, row) => ({
      costUsd: sum.costUsd + row.costUsd,
      totalTokens: sum.totalTokens + row.totalTokens,
    }),
    { costUsd: 0, totalTokens: 0 },
  );
  const last = rows.reduce<string | null>(
    (latest, row) => (latest && latest > row.lastUsedAt ? latest : row.lastUsedAt),
    null,
  );
  const loadError =
    botsQuery.error && !botsQuery.isFetching
      ? errorText(botsQuery.error, t`Could not load bots`)
      : null;
  const periods: { value: TeamUsagePeriod; label: string }[] = [
    { value: "30d", label: t`Last 30 days` },
    { value: "all", label: t`All time` },
  ];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
    >
      {loadError ? (
        <LoadFailure message={loadError} onRetry={() => void botsQuery.refetch()} />
      ) : null}
      {!botsQuery.data && !loadError ? <ActivityIndicator color={native.secondaryLabel} /> : null}
      {botsQuery.data?.length ? (
        <SettingsGroup label={t`Bots`}>
          {botsQuery.data.map((bot) => {
            const level = levelOf(bot);
            return (
              <MenuView
                key={bot.id}
                colorScheme={appearance}
                actions={options.map((option) => ({
                  id: option.value,
                  title: option.label,
                  state: option.value === level ? ("on" as const) : ("off" as const),
                  attributes: { disabled: access.pending },
                }))}
                onPressAction={({ nativeEvent }) => {
                  const chosen = options.find((option) => option.value === nativeEvent.event);
                  if (!chosen || chosen.value === level) return;
                  access.run({ bot, level: chosen.value === "none" ? null : chosen.value });
                }}
              >
                <SettingsRow
                  title={bot.name}
                  detail={bot.spaceName ?? undefined}
                  value={options.find((option) => option.value === level)?.label}
                  chevron="down"
                  leading={
                    <BotAvatar
                      identity={bot.id}
                      color={bot.color}
                      avatarSet={bot.avatarSet}
                      size={28}
                    />
                  }
                  disabled={access.pending}
                />
              </MenuView>
            );
          })}
        </SettingsGroup>
      ) : null}
      {owner && usage ? (
        <>
          <SettingsGroup label={t`Usage`}>
            <MenuView
              colorScheme={appearance}
              actions={periods.map((option) => ({
                id: option.value,
                title: option.label,
                state: option.value === period ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) => {
                const chosen = periods.find((option) => option.value === nativeEvent.event);
                if (chosen) setPeriod(chosen.value);
              }}
            >
              <SettingsRow
                title={t`Period`}
                value={periods.find((option) => option.value === period)?.label}
                chevron="down"
              />
            </MenuView>
            <SettingsRow title={t`Cost`} value={cost(total.costUsd)} />
            <SettingsRow title={t`Tokens`} value={count.format(total.totalTokens)} />
            <SettingsRow
              title={t`Last used`}
              value={last ? i18n.date(last, { dateStyle: "medium" }) : t`Never`}
            />
          </SettingsGroup>
          {rows.length ? (
            <SettingsGroup label={t`By bot`}>
              {rows.map((row) => (
                <SettingsRow
                  key={row.botId ?? "none"}
                  title={row.botName ?? t`Other`}
                  detail={count.format(row.totalTokens)}
                  value={cost(row.costUsd)}
                />
              ))}
            </SettingsGroup>
          ) : null}
        </>
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
