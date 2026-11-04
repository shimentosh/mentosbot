import { filterTeamBots, teamMembers, teamPersonName } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";

/** For a team's owner: every teammate's bot in this Space, to read. */
export default function TeamScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);
  const { data: bots = [], isPending } = useQuery(rpcQuery("team/bots"), queryClient);
  const [member, setMember] = useState<string>("all");
  const members = useMemo(() => teamMembers(bots), [bots]);
  const shown = filterTeamBots(bots, member);

  // The filter is a native header menu, shown once more than one teammate has bots.
  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () =>
        members.length > 1
          ? [
              {
                type: "menu" as const,
                label: t("Show bots of"),
                accessibilityLabel: t("Show bots of"),
                icon: { type: "sfSymbol" as const, name: "line.3.horizontal.decrease.circle" },
                menu: {
                  items: [
                    { userId: "all", label: t("Everyone") },
                    ...members.map((each) => ({
                      userId: each.userId,
                      label: teamPersonName(each),
                    })),
                  ].map((item) => ({
                    type: "action" as const,
                    label: item.label,
                    state: item.userId === member ? ("on" as const) : ("off" as const),
                    onPress: () => setMember(item.userId),
                  })),
                },
              },
            ]
          : [],
    });
  }, [navigation, members, member, t]);

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
      data={shown}
      keyExtractor={(bot) => bot.id}
      ListEmptyComponent={<Text style={styles.empty}>{t("No bots yet")}</Text>}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            router.push({
              pathname: "/team-bot",
              params: {
                botId: item.id,
                name: item.name,
                ownerName: teamPersonName(item.owner),
              },
            })
          }
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <BotAvatar
            identity={item.id}
            color={item.color}
            avatarSet={item.avatarSet}
            status={item.status}
            size={40}
          />
          <View style={styles.body}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.owner} numberOfLines={1}>
              {teamPersonName(item.owner)}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    centered: { alignItems: "center", justifyContent: "center" },
    list: { paddingBottom: 32 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center", paddingTop: 48 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    pressed: { backgroundColor: native.fill },
    body: { flex: 1, minWidth: 0 },
    name: { color: native.label, fontSize: 16, fontWeight: "600" },
    owner: { color: native.secondaryLabel, fontSize: 14, marginTop: 1 },
  });
}
