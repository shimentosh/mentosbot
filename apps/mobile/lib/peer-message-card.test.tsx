// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, createContext } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileBot, MobileSnapshot } from "./api";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  Pressable: ({
    children,
    testID,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      data-testid={testID}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: "input",
  View: ({ children, testID }: { children: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  useAnimatedStyle: (style: () => unknown) => style(),
  useReducedMotion: () => true,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "dark",
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));

vi.mock("@rakazo/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: ({ children }: { children: string }) => <p data-testid="full-text">{children}</p>,
  withBlockMentions: <T,>(blocks: T) => blocks,
  withBlockNameLinks: <T,>(blocks: T) => blocks,
}));

vi.mock("../components/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../components/pages/page-card", () => ({ PageCard: () => null }));
vi.mock("../components/ComputerCard", () => ({ ComputerCard: () => null }));
vi.mock("../components/thread/ask-block", () => ({ AskBlock: () => null }));
vi.mock("../components/AskActions", () => ({ AskActions: () => null }));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../components/change-undo", () => ({
  ChangeUndo: () => null,
  isUndoableChange: () => false,
}));
vi.mock("../components/McpApprovalCard", () => ({ McpApprovalCard: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

import { MessageBubble } from "../components/thread/message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<BubbleProps> & Pick<BubbleProps, "message">) {
  act(() =>
    root.render(
      <MessageBubble
        botId="chief"
        bots={[{ id: "kodi", color: "teal" } as MobileBot]}
        showBotSenderName={false}
        canAnswer={false}
        canDismiss={false}
        onAnswer={async () => undefined}
        onOpenBot={() => undefined}
        onOpenComputer={() => undefined}
        onPreviewFile={() => undefined}
        onPreviewImage={() => undefined}
        onOpenPeerChat={() => undefined}
        actionProps={{}}
        {...props}
      />,
    ),
  );
  const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { summary: query("peer-receipt-line")!, open: query("peer-message-open"), query };
}

const sent: BubbleProps["message"] = {
  id: "message",
  role: "bot",
  botId: "chief",
  blocks: [
    {
      kind: "bot_message_sent",
      toBotId: "kodi",
      toBotName: "KODI",
      text: "Post **published**: https://example.test/post",
    },
  ],
};

it("shows who was messaged with a one-line excerpt that expands in place", () => {
  const { summary, query } = render({ message: sent });
  expect(summary.textContent).toBe("Messaged KODIPost published: https://example.test/post");
  expect(query("full-text")).toBeNull();

  act(() => summary.click());
  expect(query("full-text")?.textContent).toBe("Post **published**: https://example.test/post");
  expect(summary.textContent).toBe("Messaged KODI");
});

it("opens the exchange from a bot's own chat", () => {
  const onOpenPeerChat = vi.fn();
  const { open } = render({ message: sent, onOpenPeerChat });
  expect(open?.getAttribute("aria-label")).toBe("Open KODI");
  act(() => open?.click());
  expect(onOpenPeerChat).toHaveBeenCalledWith({ peerBotId: "kodi", peerBotName: "KODI" });
});

it("offers nothing to open from a group chat", () => {
  expect(render({ message: sent, groupId: "group" }).open).toBeNull();
});

it("reads a group handoff as a handoff", () => {
  const { summary, open } = render({
    groupId: "group",
    members: [
      { botId: "chief", name: "Chief", color: "teal" },
      { botId: "ledger", name: "Ledger", color: "orange" },
    ] as MobileSnapshot["members"],
    message: {
      id: "handoff",
      role: "bot",
      botId: "chief",
      blocks: [{ kind: "handoff", fromBotId: "chief", toBotId: "ledger", text: "Budget check" }],
    },
  });
  expect(summary.textContent).toBe("Chief handed off to LedgerBudget check");
  expect(open).toBeNull();
});
