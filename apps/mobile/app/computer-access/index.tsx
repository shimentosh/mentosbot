import { useLingui } from "@lingui/react/macro";
import type { ComputerAccessKey } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSymbol } from "../../components/native/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { formatActivityRelativeTime } from "../../lib/inbox/activity";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

/** The keys that let an outside AI use this bot's computer over MCP. Owner only. */
export default function ComputerAccessKeys() {
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const listRead = rpcQuery("computer/accessKeys/list", { botId });
  const listing = useScreenQuery(listRead, { enabled: Boolean(botId) });
  const keys = listing.data ?? null;
  const remove = useSave({
    save: (keyId: string, send) => send("computer/accessKeys/remove", { botId, keyId }),
    stale: [listRead.queryKey],
  });
  const loadError = listing.error ? errorText(listing.error, t`Could not load`) : null;
  const removeError = remove.error ? errorText(remove.error, t`Could not remove key`) : null;

  useScreenHeader({
    action:
      botId && keys
        ? {
            label: t`Connect an AI`,
            prominence: "secondary",
            onPress: () => router.push({ pathname: "/computer-access/new", params: { botId } }),
          }
        : null,
  });

  function confirmRemove(key: ComputerAccessKey) {
    Alert.alert(key.name, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Remove`, style: "destructive", onPress: () => remove.run(key.id) },
    ]);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {loadError && !keys ? (
          <LoadFailure
            message={loadError}
            onRetry={() => void queryClient.resetQueries({ queryKey: listRead.queryKey })}
          />
        ) : null}
        {removeError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {removeError}
          </Text>
        ) : null}
        {keys?.length ? (
          <SettingsGroup>
            {keys.map((key) => {
              const used = key.lastUsedAt
                ? formatActivityRelativeTime(key.lastUsedAt)
                : t`Never used`;
              return (
                <SettingsRow
                  key={key.id}
                  accessibilityRole="button"
                  accessibilityLabel={key.name}
                  accessibilityValue={{
                    text: key.allowCommands ? `${t`Can run commands`}, ${used}` : used,
                  }}
                  disabled={remove.pending}
                  dimmed={remove.pending && remove.input === key.id}
                  title={key.name}
                  value={used}
                  trailing={
                    key.allowCommands ? (
                      <NativeSymbol
                        ios="apple.terminal"
                        android="terminal-outline"
                        size={16}
                        color={native.tertiaryLabel}
                      />
                    ) : undefined
                  }
                  onPress={() => confirmRemove(key)}
                />
              );
            })}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
