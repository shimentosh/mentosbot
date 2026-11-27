import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { PeerExchange } from "@rakazo/core";
import {
  peerExchangeBots,
  peerExchangeNames,
  plainTextFromMarkdown,
  resolvePersonaColorDef,
  splitPeerLabel,
} from "@rakazo/core";
import type { ComponentProps } from "react";
import { useState } from "react";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useI18n } from "../../lib/i18n/i18n";
import { useResolvedAppearance, useThemedStyles } from "../../lib/native/native";
import { BotAvatar } from "../bots/bot-avatar";
import { GroupAvatar } from "../bots/group-avatar";
import { NativeSymbol } from "../native/native-symbol";

const GLYPHS: Record<
  "sent" | "received" | "exchange" | "handoff",
  { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] }
> = {
  sent: { ios: "arrow.up.right", android: "arrow-forward" },
  received: { ios: "arrow.down.left", android: "arrow-back" },
  exchange: { ios: "arrow.left.arrow.right", android: "swap-horizontal" },
  handoff: { ios: "arrow.turn.up.right", android: "arrow-redo" },
};

type BotLook = { color?: string; avatarSet?: BotAvatarSet } | undefined;

/**
 * What one bot sent another: who, a one-line excerpt that expands in place, and an Open that
 * leads to the whole exchange when the viewer can see it. A line that spans several bots names
 * them all and expands to one row per message, each with its own Open.
 */
export function PeerMessageCard({
  peerBotId,
  peerBotName,
  color,
  avatarSet,
  label,
  direction,
  text,
  onOpen,
  actionProps,
  exchange,
  lookOf,
  onOpenPeer,
}: {
  peerBotId: string;
  peerBotName: string;
  /** The bot's stored color; unknown bots fall back to their identity color. */
  color?: string;
  avatarSet?: BotAvatarSet;
  label: string;
  direction: keyof typeof GLYPHS;
  text: string;
  onOpen?: () => void;
  actionProps: Pick<
    PressableProps,
    "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
  >;
  exchange?: PeerExchange;
  lookOf?: (botId: string) => BotLook;
  onOpenPeer?: (peer: { peerBotId: string; peerBotName: string }) => void;
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const [expanded, setExpanded] = useState(false);
  const bots = exchange ? peerExchangeBots(exchange) : [];
  if (exchange && bots.length > 1) {
    const latest = exchange.entries.at(-1);
    const colorOf = (id: string) => lookOf?.(id)?.color ?? tokens.mutedForeground;
    return (
      <View testID="peer-message-card" style={styles.card}>
        <Pressable
          {...actionProps}
          testID="peer-receipt-line"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.summary, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={styles.label}>
            <NativeSymbol
              ios={GLYPHS.exchange.ios}
              android={GLYPHS.exchange.android}
              size={12}
              color={tokens.mutedForeground}
            />
            <GroupAvatar
              size={16}
              members={bots.map((bot) => ({
                botId: bot.id,
                name: bot.name,
                color: colorOf(bot.id),
                avatarSet: lookOf?.(bot.id)?.avatarSet,
              }))}
            />
            <Text numberOfLines={1} style={[styles.labelText, styles.groupLabel]}>
              {t("Messages with {names}", { names: peerExchangeNames(bots) })}
            </Text>
          </View>
          {latest && !expanded ? (
            <Text numberOfLines={1} style={styles.excerpt}>
              {`${latest.peerBotName}: ${plainTextFromMarkdown(latest.text)}`}
            </Text>
          ) : null}
        </Pressable>
        {expanded
          ? exchange.entries.map((entry, index) => {
              const entryGlyph = GLYPHS[entry.direction];
              return (
                <View key={`${entry.messageId}:${index}`} style={styles.entry}>
                  <View style={styles.summary}>
                    <View style={styles.label}>
                      <NativeSymbol
                        ios={entryGlyph.ios}
                        android={entryGlyph.android}
                        size={12}
                        color={tokens.mutedForeground}
                      />
                      <BotAvatar
                        avatarSet={lookOf?.(entry.peerBotId)?.avatarSet}
                        color={colorOf(entry.peerBotId)}
                        identity={entry.peerBotId}
                        size={16}
                      />
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.labelText,
                          styles.name,
                          {
                            color: resolvePersonaColorDef(
                              entry.peerBotId,
                              lookOf?.(entry.peerBotId)?.color,
                            ).hex,
                          },
                        ]}
                      >
                        {entry.peerBotName}
                      </Text>
                    </View>
                    <Text numberOfLines={2} style={styles.excerpt}>
                      {plainTextFromMarkdown(entry.text)}
                    </Text>
                  </View>
                  {onOpenPeer &&
                  // One Open per bot: its later rows lead to the same conversation.
                  exchange.entries.findIndex((e) => e.peerBotId === entry.peerBotId) === index ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("Open {name}", { name: entry.peerBotName })}
                      hitSlop={8}
                      onPress={() =>
                        onOpenPeer({ peerBotId: entry.peerBotId, peerBotName: entry.peerBotName })
                      }
                      style={({ pressed }) => [styles.open, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Text style={styles.labelText}>{t("Open")}</Text>
                      <NativeSymbol
                        ios="chevron.right"
                        android="chevron-forward"
                        size={11}
                        color={tokens.mutedForeground}
                      />
                    </Pressable>
                  ) : null}
                </View>
              );
            })
          : null}
      </View>
    );
  }
  const parts = splitPeerLabel(label, peerBotName);
  const excerpt = plainTextFromMarkdown(text);
  const glyph = GLYPHS[direction];
  return (
    <View testID="peer-message-card" style={styles.card}>
      <View style={styles.row}>
        <Pressable
          {...actionProps}
          testID="peer-receipt-line"
          accessible
          accessibilityRole={excerpt ? "button" : undefined}
          accessibilityState={excerpt ? { expanded } : undefined}
          onPress={excerpt ? () => setExpanded((value) => !value) : undefined}
          style={({ pressed }) => [styles.summary, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={styles.label}>
            <NativeSymbol
              ios={glyph.ios}
              android={glyph.android}
              size={12}
              color={tokens.mutedForeground}
            />
            {parts.before ? <Text style={styles.labelText}>{parts.before}</Text> : null}
            <BotAvatar
              avatarSet={avatarSet}
              color={color ?? tokens.mutedForeground}
              identity={peerBotId}
              size={16}
            />
            {parts.name ? (
              <Text
                numberOfLines={1}
                style={[
                  styles.labelText,
                  styles.name,
                  { color: resolvePersonaColorDef(peerBotId, color).hex },
                ]}
              >
                {parts.name}
              </Text>
            ) : null}
            {parts.after ? <Text style={styles.labelText}>{parts.after}</Text> : null}
          </View>
          {excerpt && !expanded ? (
            <Text numberOfLines={1} style={styles.excerpt}>
              {excerpt}
            </Text>
          ) : null}
        </Pressable>
        {onOpen ? (
          <Pressable
            testID="peer-message-open"
            accessibilityRole="button"
            accessibilityLabel={t("Open {name}", { name: peerBotName })}
            hitSlop={8}
            onPress={onOpen}
            style={({ pressed }) => [styles.open, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={styles.labelText}>{t("Open")}</Text>
            <NativeSymbol
              ios="chevron.right"
              android="chevron-forward"
              size={11}
              color={tokens.mutedForeground}
            />
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.body}>
          <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
            {text}
          </ChatMarkdown>
        </View>
      ) : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    card: {
      alignSelf: "center",
      width: "100%",
      maxWidth: 448,
      marginVertical: 4,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    summary: { flex: 1, minWidth: 0, gap: 2 },
    label: { flexDirection: "row", alignItems: "center", gap: 4 },
    labelText: { color: tokens.mutedForeground, fontSize: 13 },
    name: { fontWeight: "500", flexShrink: 1 },
    excerpt: { color: tokens.foreground, opacity: 0.75, fontSize: 13 },
    open: { flexDirection: "row", alignItems: "center", gap: 2 },
    body: { marginTop: 6 },
    groupLabel: { flexShrink: 1 },
    entry: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 6 },
  });
}
