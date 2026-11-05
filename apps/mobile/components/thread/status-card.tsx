import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import type { CardBlock, CardStatus } from "@rakazo/contracts";
import { cardLinks, cardStatus } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { NativeActionButton } from "../native-action-button";
import { NativeSymbol } from "../native-symbol";
import type { MessageActionProps } from "./message-bubble";

const STATUS_SYMBOLS: Record<
  CardStatus,
  Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">
> = {
  done: { ios: "checkmark.circle.fill", android: "checkmark-circle" },
  pending: { ios: "clock", android: "time-outline" },
  failed: { ios: "xmark.circle.fill", android: "close-circle" },
  info: { ios: "info.circle", android: "information-circle-outline" },
};

/** A receipt or status a bot showed: what happened, a few facts, and links to the result. */
export function StatusCard({
  block,
  actionProps,
}: {
  block: CardBlock;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const openLink = useNativeLinkConfirm();
  const status = cardStatus(block);
  const links = cardLinks(block);
  const color = {
    done: tokens.success,
    pending: tokens.warning,
    failed: tokens.destructive,
    info: tokens.mutedForeground,
  }[status];
  const statusLabel = { done: t("Done"), pending: t("Pending"), failed: t("Failed"), info: "" }[
    status
  ];
  return (
    <Pressable
      {...actionProps}
      testID="status-card"
      style={{
        width: "90%",
        maxWidth: 400,
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      {block.title ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View
            accessible={Boolean(statusLabel)}
            accessibilityLabel={statusLabel || undefined}
            importantForAccessibility={statusLabel ? "yes" : "no-hide-descendants"}
            style={{ paddingTop: 2 }}
          >
            <NativeSymbol {...STATUS_SYMBOLS[status]} size={18} color={color} />
          </View>
          <Text style={{ flex: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}>
            {block.title}
          </Text>
        </View>
      ) : null}
      {block.lines.length > 0 ? (
        <View style={{ gap: 4, paddingStart: block.title ? 26 : 0 }}>
          {block.lines.map((line, index) => (
            <View key={`${line.k}-${index}`} accessible style={{ flexDirection: "row", gap: 12 }}>
              <Text
                style={{
                  flexShrink: 0,
                  maxWidth: "45%",
                  color: tokens.mutedForeground,
                  ...typeScale.secondary,
                }}
              >
                {line.k}
              </Text>
              <Text style={{ flex: 1, color: tokens.cardForeground, ...typeScale.secondary }}>
                {line.v}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {links.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            paddingStart: block.title ? 26 : 0,
          }}
        >
          {links.map((link) => (
            <NativeActionButton
              key={link.url}
              label={link.label}
              prominence="secondary"
              size="compact"
              fill={false}
              icon={{ ios: "arrow.up.right", android: "open-outline" }}
              onPress={() => openLink(link.url)}
            />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}
