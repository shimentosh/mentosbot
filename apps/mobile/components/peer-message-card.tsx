import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { BotAvatarSet } from "@rakazo/contracts";
import { plainTextFromMarkdown, resolvePersonaColorDef, splitPeerLabel } from "@rakazo/core";
import type { ComponentProps } from "react";
import { useState } from "react";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance, useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

const GLYPHS: Record<
  "sent" | "received" | "exchange" | "handoff",
  { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] }
> = {
  sent: { ios: "arrow.up.right", android: "arrow-forward" },
  received: { ios: "arrow.down.left", android: "arrow-back" },
  exchange: { ios: "arrow.left.arrow.right", android: "swap-horizontal" },
  handoff: { ios: "arrow.turn.up.right", android: "arrow-redo" },
};

/**
 * What one bot sent another: who, a one-line excerpt that expands in place, and an Open that
 * leads to the whole exchange when the viewer can see it.
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
}) {
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const [expanded, setExpanded] = useState(false);
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
  });
}
