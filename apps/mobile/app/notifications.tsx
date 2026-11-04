import type { InboxEntry } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { formatActivityRelativeTime } from "../lib/activity";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { bellRoute, inboxRows } from "../lib/bell";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";

/** What needs the person and what their bots just did, across the organization's Spaces. */
export default function NotificationsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const query = rpcQuery("inbox/list");
  const { data: inbox, isPending, refetch } = useQuery(query, queryClient);
  const unread = useRef(0);
  unread.current = inbox?.unread ?? 0;
  // New work stays marked while the list is open; leaving it marks it seen.
  useFocusEffect(
    useCallback(() => {
      void refetch();
      return () => {
        if (!unread.current) return;
        void rpc("inbox/markRead").then(() =>
          queryClient.invalidateQueries({ queryKey: query.queryKey }),
        );
      };
    }, [refetch, query.queryKey]),
  );
  const rows = useMemo(
    () => (inbox ? inboxRows(inbox, { needsYou: t("Needs you"), recent: t("Recent") }) : []),
    [inbox, t],
  );

  const kindText = (entry: InboxEntry, count: number) => {
    switch (entry.kind) {
      case "approval":
        return t("Needs your approval");
      case "answer":
        return t("Has a question");
      case "takeover":
        return t("Needs you on the screen");
      case "failure":
        return count === 1 ? t("Failed") : t("Failed {count} times", { count });
      default:
        return count === 1 ? t("Finished") : t("Finished {count} tasks", { count });
    }
  };

  if (isPending)
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator />
      </View>
    );
  return (
    <FlatList
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={<Text style={styles.empty}>{t("You're all caught up")}</Text>}
      renderItem={({ item }) =>
        item.type === "header" ? (
          <Text style={styles.header} accessibilityRole="header">
            {item.title}
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(bellRoute(item.entry))}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <BotAvatar
              identity={item.entry.bot.id}
              color={item.entry.bot.color}
              avatarSet={item.entry.bot.avatarSet}
              size={36}
            />
            <View style={styles.body}>
              <View style={styles.titleLine}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.entry.bot.name}
                </Text>
                {inbox && item.entry.spaceId !== inbox.spaceId ? (
                  <Text style={styles.space} numberOfLines={1}>
                    {item.entry.spaceName}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.kind} numberOfLines={1}>
                {kindText(item.entry, item.count)}
              </Text>
            </View>
            <Text style={styles.time}>{formatActivityRelativeTime(item.entry.at)}</Text>
            {item.highlight ? <View style={styles.dot} /> : null}
          </Pressable>
        )
      }
    />
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: { alignItems: "center", justifyContent: "center" },
    list: { paddingBottom: 32 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center", paddingTop: 48 },
    header: {
      color: native.secondaryLabel,
      fontSize: 13,
      fontWeight: "600",
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 6,
      textTransform: "uppercase",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    pressed: { backgroundColor: native.fill },
    body: { flex: 1, minWidth: 0 },
    titleLine: { flexDirection: "row", alignItems: "baseline", gap: 6 },
    name: { color: native.label, fontSize: 16, fontWeight: "600", flexShrink: 1 },
    space: { color: native.secondaryLabel, fontSize: 13, flexShrink: 1 },
    kind: { color: native.secondaryLabel, fontSize: 14, marginTop: 1 },
    time: { color: native.secondaryLabel, fontSize: 13 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.primary },
  });
}
