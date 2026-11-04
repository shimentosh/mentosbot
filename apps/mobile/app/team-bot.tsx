import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ThreadMessage } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { openMobileArtifact } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { queryClient } from "../lib/query";
import { errorText } from "../lib/user-error";

/** A teammate's bot's chat for the team's owner: reading only, newest at the bottom. */
export default function TeamBotScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const params = useLocalSearchParams<{ botId: string; name?: string; ownerName?: string }>();
  const botId = params.botId;
  const pages = useInfiniteQuery(
    {
      queryKey: ["team-bot-messages", botId],
      queryFn: ({ pageParam }) => rpc("team/botMessages", { botId, before: pageParam }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (page) => page.olderCursor ?? undefined,
    },
    queryClient,
  );
  const messages = useMemo(
    () =>
      [...(pages.data?.pages ?? [])]
        .reverse()
        .flatMap((page) => page.messages)
        .filter((message) => message.role !== "system"),
    [pages.data],
  );

  const text = (message: ThreadMessage) =>
    message.blocks
      .flatMap((block) => (block.kind === "text" || block.kind === "ask" ? [block.text] : []))
      .join("\n\n")
      .trim();

  return (
    <View style={styles.screen}>
      <Stack.Screen options={glassHeaderOptions(params.name ?? "")} />
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {pages.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.mutedForeground} />
          </View>
        ) : pages.isError ? (
          <View style={styles.center}>
            <Text style={styles.muted}>{t("Could not load this chat.")}</Text>
            <Pressable accessibilityRole="button" onPress={() => void pages.refetch()} hitSlop={8}>
              <Text style={styles.retry}>{t("Try again")}</Text>
            </Pressable>
          </View>
        ) : messages.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>{t("No messages yet")}</Text>
          </View>
        ) : (
          <>
            {pages.hasNextPage ? (
              <NativeActionButton
                label={t("Show earlier")}
                prominence="plain"
                onPress={() => void pages.fetchNextPage()}
              />
            ) : null}
            {messages.map((message) => {
              const fromPerson = message.role === "user";
              const body = text(message);
              const files = message.blocks.filter(
                (block) => block.kind === "file" || block.kind === "image",
              );
              if (!body && files.length === 0) return null;
              return (
                <View
                  key={message.id}
                  style={[styles.message, fromPerson ? styles.sent : styles.received]}
                >
                  <View style={[styles.bubble, fromPerson && styles.sentBubble]}>
                    {/* A teammate it is shared with wrote it; only the bot's owner is named here. */}
                    {fromPerson && message.authorUserId ? null : (
                      <Text style={styles.speaker} numberOfLines={1}>
                        {fromPerson ? params.ownerName : params.name}
                      </Text>
                    )}
                    {body ? (
                      <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                        {body}
                      </ChatMarkdown>
                    ) : null}
                  </View>
                  {files.map((block, index) =>
                    block.kind === "file" || block.kind === "image" ? (
                      <NativeActionButton
                        key={index}
                        label={block.name}
                        prominence="plain"
                        onPress={() =>
                          void openMobileArtifact(
                            { botId },
                            block.artifactId,
                            block.name,
                            block.mimeType,
                          ).catch((error) =>
                            Alert.alert(
                              t("Could not open file"),
                              errorText(error, t("Try again.")),
                            ),
                          )
                        }
                      />
                    ) : null,
                  )}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingVertical: 16, gap: 10 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
    muted: { color: tokens.mutedForeground, ...typeScale.body, textAlign: "center" },
    retry: { color: tokens.link, ...typeScale.body },
    message: { maxWidth: "85%", gap: 6 },
    bubble: {
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 9,
      backgroundColor: tokens.muted,
    },
    sent: { alignSelf: "flex-end" },
    received: { alignSelf: "flex-start" },
    sentBubble: { backgroundColor: tokens.accent },
    speaker: { color: tokens.mutedForeground, ...typeScale.footnote, marginBottom: 4 },
  });
}
