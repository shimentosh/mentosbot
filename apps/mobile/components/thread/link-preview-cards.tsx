import {
  linkPreviewSite,
  useLinkFavicon,
  useLinkPreview,
  useNativeLinkConfirm,
} from "@rakazo/chat-ui/native";
import type { LinkPreview } from "@rakazo/contracts";
import { fontWeight, MAX_FONT_SCALE, typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native";
import { NativeSymbol } from "../native-symbol";

/** Cards for the links a message shares, drawn once the server has read each page. */
export function LinkPreviewCards({
  urls,
  end = false,
}: {
  urls: readonly string[];
  end?: boolean;
}) {
  if (urls.length === 0) return null;
  return (
    <View style={{ alignItems: end ? "flex-end" : "flex-start" }}>
      {urls.map((url) => (
        <LinkPreviewCard key={url} url={url} />
      ))}
    </View>
  );
}

function LinkPreviewCard({ url }: { url: string }) {
  const preview = useLinkPreview(url);
  // Nothing is drawn until the page has been read, so a card never pushes the chat around twice.
  return preview ? <LoadedLinkPreviewCard url={url} preview={preview} /> : null;
}

function LoadedLinkPreviewCard({ url, preview }: { url: string; preview: LinkPreview }) {
  const tokens = useMobileTokens();
  const { icon, unusable } = useLinkFavicon(url);
  const openLink = useNativeLinkConfirm();
  const [imageFailed, setImageFailed] = useState(false);
  const site = linkPreviewSite(url, preview);
  const showImage = Boolean(preview.image) && !imageFailed;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${preview.title}, ${site}`}
      testID="link-preview"
      onPress={() => openLink(url)}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: tokens.card,
          borderColor: tokens.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {showImage ? (
        <Image
          source={{ uri: preview.image! }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImageFailed(true)}
        />
      ) : null}
      <View
        style={[styles.text, showImage && styles.belowImage, { borderTopColor: tokens.border }]}
      >
        <Text
          numberOfLines={2}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[styles.title, { color: tokens.foreground }]}
        >
          {preview.title}
        </Text>
        {preview.description ? (
          <Text
            numberOfLines={2}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[styles.description, { color: tokens.mutedForeground }]}
          >
            {preview.description}
          </Text>
        ) : null}
        <View style={styles.site}>
          {icon ? (
            <Image
              source={{ uri: icon }}
              style={[styles.icon, { backgroundColor: tokens.faviconPlate }]}
              resizeMode="contain"
              onError={unusable}
            />
          ) : (
            <NativeSymbol
              ios="globe"
              android="globe-outline"
              size={13}
              color={tokens.mutedForeground}
            />
          )}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[styles.siteName, { color: tokens.mutedForeground }]}
          >
            {site}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 300,
    maxWidth: "100%",
    marginTop: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  image: {
    width: "100%",
    aspectRatio: 1.91,
  },
  text: { paddingHorizontal: 14, paddingVertical: 11, gap: 2 },
  belowImage: { borderTopWidth: StyleSheet.hairlineWidth },
  title: { ...typeScale.secondary, fontWeight: fontWeight.semibold },
  description: typeScale.caption,
  site: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  icon: { width: 16, height: 16, borderRadius: 4, padding: 1 },
  siteName: { ...typeScale.footnote, flexShrink: 1 },
});
