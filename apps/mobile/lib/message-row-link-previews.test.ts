import type { ComponentProps } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Which links get a card is chat-ui's shared rule, tested there; this checks what the row asks.
  linkPreviewUrls: vi.fn(
    (_texts: readonly string[], _options: { plain?: boolean; appOrigin?: string | null }) => [
      "https://site.example.test/post",
    ],
  ),
  shown: undefined as { urls: readonly string[]; end?: boolean } | undefined,
}));

vi.mock("react-native", () => ({
  ActionSheetIOS: {},
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  View: "div",
}));
vi.mock("react-native-reanimated", () => ({
  default: { Text: "span" },
  useReducedMotion: () => true,
  ZoomIn: {},
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@rakazo/chat-ui/native", () => ({
  linkPreviewUrls: mocks.linkPreviewUrls,
  markdownCodeBlocks: () => [],
}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("../components/message-action-menu", () => ({ presentMessageMenu: vi.fn() }));
vi.mock("../components/message-context-menu", () => ({
  MessageContextMenu: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/reply-line", () => ({ ReplyLine: () => null }));
vi.mock("../components/time-separator", () => ({ TimeSeparator: () => null }));
vi.mock("../components/unread-divider", () => ({ UnreadDivider: () => null }));
vi.mock("../components/thread/message-bubble", () => ({ MessageBubble: () => null }));
vi.mock("../components/thread/link-preview-cards", () => ({
  LinkPreviewCards: (props: { urls: readonly string[]; end?: boolean }) => {
    mocks.shown = props;
    return null;
  },
}));

import { MessageRow } from "../components/thread/message-row";
import { currentApiBase } from "./api";

type RowProps = ComponentProps<typeof MessageRow>;

function renderRow(id: string, role: "bot" | "user", blocks: unknown[]) {
  const props = {
    message: { id, role, createdAt: "2026-01-01T00:00:00.000Z", blocks },
    actions: {},
    bubbleBotId: "bot-1",
    showBotSenderName: false,
    bots: [],
    readOnly: false,
    onCall: false,
    canAnswer: false,
    canDismiss: false,
    highlighted: false,
    separator: false,
    headerAdjacent: false,
    unreadDivider: false,
    markedUnread: false,
    replyAuthor: "",
    waitingForUser: false,
    inGroup: false,
    columnWidth: 400,
    enableJump: false,
    index: 0,
  } as unknown as RowProps;
  renderToStaticMarkup(createElement(MessageRow, props));
}

beforeEach(() => {
  mocks.linkPreviewUrls.mockClear();
  mocks.shown = undefined;
});

it("asks the shared rule about a reply's text and draws its cards on the reply's side", () => {
  renderRow("message-1", "bot", [
    { kind: "text", text: "Posted: https://site.example.test/post" },
    { kind: "image", artifactId: "artifact-1" },
  ]);
  expect(mocks.linkPreviewUrls).toHaveBeenCalledWith(["Posted: https://site.example.test/post"], {
    plain: false,
    appOrigin: currentApiBase(),
  });
  expect(mocks.shown).toEqual({ urls: ["https://site.example.test/post"], end: false });
});

it("reads a person's message as literal text and draws its cards on their side", () => {
  renderRow("message-2", "user", [{ kind: "text", text: "https://site.example.test/post" }]);
  expect(mocks.linkPreviewUrls).toHaveBeenCalledWith(
    ["https://site.example.test/post"],
    expect.objectContaining({ plain: true }),
  );
  expect(mocks.shown?.end).toBe(true);
});

it("draws no cards and looks nothing up while a reply is streaming", () => {
  renderRow("progress:run-1", "bot", [{ kind: "text", text: "https://site.example.test/po" }]);
  expect(mocks.linkPreviewUrls).not.toHaveBeenCalled();
  expect(mocks.shown?.urls).toEqual([]);
});
