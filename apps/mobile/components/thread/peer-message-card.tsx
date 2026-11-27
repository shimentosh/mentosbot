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
import type { ComponentProps, ReactNode } from "react";
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
 * What one bot sent another, as one quiet line: who, and a one-line excerpt. The line opens the
 * whole exchange when the viewer can see it, and otherwise expands in place. While the other bot
 * is still working on it, the excerpt says so. A line that spans several bots names them all and
 * expands to one row per message, each opening its bot.
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
  working = false,
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
  /** The other bot is still at work, so the line shows that instead of the excerpt. */
  working?: boolean;
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
  const glyph = (name: keyof typeof GLYPHS) => (
    <NativeSymbol
      ios={GLYPHS[name].ios}
      android={GLYPHS[name].android}
      size={12}
      color={tokens.mutedForeground}
    />
  );
  const chevron = (ios: string, android: ComponentProps<typeof NativeSymbol>["android"]) => (
    <NativeSymbol ios={ios} android={android} size={11} color={tokens.mutedForeground} />
  );
  const botName = (id: string, name: string, look?: BotLook) => (
    <Text
      numberOfLines={1}
      style={[styles.text, styles.name, { color: resolvePersonaColorDef(id, look?.color).hex }]}
    >
      {name}
    </Text>
  );
  const excerptText = (value: ReactNode) => (
    <Text numberOfLines={1} style={[styles.text, styles.excerpt]}>
      {value}
    </Text>
  );

  if (exchange && bots.length > 1) {
    const latest = exchange.entries.at(-1);
    return (
      <View testID="peer-message-card" style={styles.card}>
        <Pressable
          {...actionProps}
          testID="peer-receipt-line"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
        >
          {glyph("exchange")}
          <GroupAvatar
            size={16}
            members={bots.map((bot) => ({
              botId: bot.id,
              name: bot.name,
              color: lookOf?.(bot.id)?.color ?? tokens.mutedForeground,
              avatarSet: lookOf?.(bot.id)?.avatarSet,
            }))}
          />
          <Text numberOfLines={1} style={[styles.text, styles.name]}>
            {peerExchangeNames(bots)}
          </Text>
          {excerptText(
            latest && !expanded
              ? `${latest.peerBotName}: ${plainTextFromMarkdown(latest.text)}`
              : null,
          )}
          {expanded ? chevron("chevron.up", "chevron-up") : chevron("chevron.down", "chevron-down")}
        </Pressable>
        {expanded
          ? exchange.entries.map((entry, index) => {
              const look = lookOf?.(entry.peerBotId);
              return (
                <Pressable
                  key={`${entry.messageId}:${index}`}
                  accessibilityRole={onOpenPeer ? "button" : undefined}
                  accessibilityLabel={
                    onOpenPeer ? t("Open {name}", { name: entry.peerBotName }) : undefined
                  }
                  disabled={!onOpenPeer}
                  onPress={() =>
                    onOpenPeer?.({ peerBotId: entry.peerBotId, peerBotName: entry.peerBotName })
                  }
                  style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
                >
                  {glyph(entry.direction)}
                  <BotAvatar
                    avatarSet={look?.avatarSet}
                    color={look?.color ?? tokens.mutedForeground}
                    identity={entry.peerBotId}
                    size={16}
                  />
                  {botName(entry.peerBotId, entry.peerBotName, look)}
                  {excerptText(plainTextFromMarkdown(entry.text))}
                  {onOpenPeer ? chevron("chevron.right", "chevron-forward") : null}
                </Pressable>
              );
            })
          : null}
      </View>
    );
  }

  const parts = splitPeerLabel(label, peerBotName);
  const excerpt = plainTextFromMarkdown(text);
  return (
    <View testID="peer-message-card" style={styles.card}>
      <Pressable
        {...actionProps}
        testID="peer-receipt-line"
        accessible
        accessibilityRole={onOpen || excerpt ? "button" : undefined}
        accessibilityLabel={onOpen ? t("Open {name}", { name: peerBotName }) : undefined}
        accessibilityState={!onOpen && excerpt ? { expanded } : undefined}
        onPress={onOpen ?? (excerpt ? () => setExpanded((value) => !value) : undefined)}
        style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
      >
        {glyph(direction)}
        {parts.before ? <Text style={styles.text}>{parts.before}</Text> : null}
        <BotAvatar
          avatarSet={avatarSet}
          color={color ?? tokens.mutedForeground}
          identity={peerBotId}
          size={16}
        />
        {parts.name ? botName(peerBotId, parts.name, { color }) : null}
        {parts.after ? <Text style={styles.text}>{parts.after}</Text> : null}
        {excerptText(working ? t("Working…") : expanded ? null : excerpt)}
        {onOpen ? chevron("chevron.right", "chevron-forward") : null}
      </Pressable>
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
    card: { alignSelf: "center", width: "100%", maxWidth: 448, marginVertical: 2 },
    line: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    text: { color: tokens.mutedForeground, fontSize: 13 },
    name: { fontWeight: "500", flexShrink: 0, maxWidth: "45%" },
    excerpt: { flex: 1, minWidth: 0, color: tokens.foreground, opacity: 0.75 },
    body: { paddingHorizontal: 8, paddingBottom: 4 },
  });
}
