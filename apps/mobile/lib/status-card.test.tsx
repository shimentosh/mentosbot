// @vitest-environment jsdom

import type { CardBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const element =
    (tag: string) =>
    (props: {
      children?: ReactNode;
      testID?: string;
      accessibilityLabel?: string;
      style?: unknown;
    }) =>
      createElement(
        tag,
        {
          "data-testid": props.testID,
          "aria-label": props.accessibilityLabel,
          "data-color": (props.style as { color?: string } | undefined)?.color,
        },
        props.children,
      );
  return { Pressable: element("div"), Text: element("span"), View: element("div") };
});

vi.mock("@rakazo/chat-ui/native", () => ({
  useNativeLinkConfirm: () => (url: string) => opened.push(url),
}));

vi.mock("./native", () => ({
  useMobileTokens: () => ({
    card: "card",
    cardForeground: "foreground",
    mutedForeground: "muted",
    success: "success",
    warning: "warning",
    destructive: "destructive",
  }),
}));

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: (props: { ios: string; color: string }) => (
    <i data-symbol={props.ios} data-color={props.color} />
  ),
}));

vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: { label: string; onPress: () => void }) => (
    <button type="button" onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { StatusCard } from "../components/thread/status-card";

const actionProps = {};

describe("StatusCard", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    opened.length = 0;
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

  function render(block: CardBlock) {
    act(() => root.render(<StatusCard block={block} actionProps={actionProps} />));
    return container.querySelector('[data-testid="status-card"]')!;
  }

  it("shows a receipt with its status, facts and link", () => {
    const card = render({
      kind: "card",
      title: "Post published",
      lines: [{ k: "Account", v: "@handle" }],
      links: [{ label: "View post", url: "https://social.example.test/p/1" }],
    });
    expect(card.querySelector("[data-symbol]")?.getAttribute("data-color")).toBe("success");
    expect(card.querySelector('[aria-label="Done"]')).not.toBeNull();
    expect(card.textContent).toContain("Post published");
    expect(card.textContent).toContain("Account@handle");
    act(() => card.querySelector("button")!.click());
    expect(opened).toEqual(["https://social.example.test/p/1"]);
  });

  it("colors a failed card and drops links it cannot open", () => {
    const card = render({
      kind: "card",
      title: "Email not sent",
      status: "failed",
      lines: [],
      links: [{ label: "Open", url: "javascript:alert(1)" }],
    });
    expect(card.querySelector("[data-symbol]")?.getAttribute("data-color")).toBe("destructive");
    expect(card.querySelector('[aria-label="Failed"]')).not.toBeNull();
    expect(card.querySelector("button")).toBeNull();
  });

  it("shows an old card's lines without a title row", () => {
    const card = render({ kind: "card", lines: [{ k: "Due", v: "Monday" }] });
    expect(card.querySelector("[data-symbol]")).toBeNull();
    expect(card.textContent).toBe("DueMonday");
  });
});
