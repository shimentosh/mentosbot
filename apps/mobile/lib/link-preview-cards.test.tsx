// @vitest-environment jsdom

import type { LinkPreview } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const previews = vi.hoisted(() => new Map<string, LinkPreview>());
const openLink = vi.hoisted(() => vi.fn());

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const element =
    (tag: string) =>
    ({
      children,
      onPress,
      accessibilityRole,
      accessibilityLabel,
      testID,
      source,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      testID?: string;
      source?: { uri: string };
    }) =>
      createElement(
        tag,
        {
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          "data-testid": testID,
          src: source?.uri,
          onClick: onPress,
        },
        children,
      );
  return {
    Image: element("img"),
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: element("span"),
    View: element("div"),
  };
});
vi.mock("@rakazo/chat-ui/native", () => ({
  linkPreviewSite: (url: string, preview: LinkPreview) =>
    preview.siteName ?? new URL(url).hostname.replace(/^www\./, ""),
  useLinkPreview: (url: string) => previews.get(url) ?? null,
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
  useNativeLinkConfirm: () => openLink,
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));

import { LinkPreviewCards } from "../components/thread/link-preview-cards";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  previews.clear();
  openLink.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("draws nothing for a link the server has no preview for yet", () => {
  act(() => root.render(<LinkPreviewCards urls={["https://none.example.test/"]} />));
  expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
});

it("draws the page's card and opens the link through the link prompt", () => {
  previews.set("https://www.site.example.test/post", {
    title: "A post",
    description: "What it says",
    siteName: null,
    image: "data:image/jpeg;base64,AAAA",
  });
  act(() => root.render(<LinkPreviewCards urls={["https://www.site.example.test/post"]} />));
  const card = container.querySelector<HTMLElement>('[data-testid="link-preview"]')!;
  expect(card.getAttribute("role")).toBe("link");
  expect(card.getAttribute("aria-label")).toBe("A post, site.example.test");
  expect(card.textContent).toContain("What it says");
  expect(card.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  act(() => card.click());
  expect(openLink).toHaveBeenCalledWith("https://www.site.example.test/post");
});
