import type { BotAvatarSet } from "@rakazo/contracts";
import type { ChildBotBlock } from "@rakazo/core";
import { resolvePersonaColorDef } from "@rakazo/core";
import type { ColorTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { MessageMentionsContext } from "../../lib/messages/message-mentions";
import { BotAvatar } from "../bots/bot-avatar";
import { NativeSymbol } from "../native/native-symbol";

const ICON_SIZE = 16;

/** A bot named inline in its color. A deleted, archived, or missing bot keeps only its name. */
export function BotMention({
  block,
  color,
  avatarSet,
  tokens,
  onOpenBot,
}: {
  block: ChildBotBlock;
  color: string | undefined;
  avatarSet?: BotAvatarSet;
  tokens: ColorTokens;
  onOpenBot: (botId: string, name: string) => void;
}) {
  const live = block.status === "created" && color;
  return (
    <Text
      accessibilityRole={live ? "link" : undefined}
      onPress={live ? () => onOpenBot(block.botId, block.name) : undefined}
      style={{
        color: live ? resolvePersonaColorDef(block.botId, color).hex : tokens.foreground,
        fontWeight: "500",
      }}
    >
      {/* An inline view sits on the baseline; this lowers it to centre on the capitals. */}
      <View style={{ width: ICON_SIZE + 5, height: ICON_SIZE, transform: [{ translateY: 3 }] }}>
        {live ? (
          <BotAvatar color={color} avatarSet={avatarSet} identity={block.botId} size={ICON_SIZE} />
        ) : (
          <NativeSymbol
            ios="person"
            android="person-outline"
            size={ICON_SIZE - 2}
            color={tokens.mutedForeground}
          />
        )}
      </View>
      {block.name}
    </Text>
  );
}

/** Lets a reply's text name the bots it announces. */
export function MessageMentions({
  mentions,
  colorOf,
  onOpenBot,
  named = [],
  children,
}: {
  mentions: readonly ChildBotBlock[];
  /** Other bots the reply names, linked to their chats. */
  named?: readonly { id: string; name: string }[];
  colorOf: (botId: string) => string | undefined;
  onOpenBot: (botId: string, name: string) => void;
  children: ReactNode;
}) {
  const mentionLink = (id: string) => {
    const block = mentions.find((mention) => mention.botId === id);
    const color = colorOf(id);
    if (block) {
      if (block.status !== "created" || !color) return undefined;
      return {
        color: resolvePersonaColorDef(id, color).hex,
        open: () => onOpenBot(block.botId, block.name),
      };
    }
    const bot = named.find((entry) => entry.id === id);
    if (!bot || !color) return undefined;
    return { color: resolvePersonaColorDef(id, color).hex, open: () => onOpenBot(id, bot.name) };
  };
  return (
    <MessageMentionsContext.Provider value={mentionLink}>
      {children}
    </MessageMentionsContext.Provider>
  );
}
