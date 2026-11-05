// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveBotGlyph, PeerMessageCard } from "./CollaborationMarker";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderCard(props: Partial<Parameters<typeof PeerMessageCard>[0]> = {}) {
  act(() =>
    root.render(
      <PeerMessageCard
        direction="sent"
        peerName="KODI · COO"
        color="#14B8A6"
        identity="kodi"
        label="Messaged KODI · COO"
        text={"Post **published**:\n\nhttps://example.test/post"}
        {...props}
      />,
    ),
  );
  return {
    toggle: container.querySelector<HTMLButtonElement>('[data-testid="peer-receipt-chip"]')!,
    open: container.querySelector<HTMLButtonElement>('button[aria-label^="Open"]'),
  };
}

describe("peer message card", () => {
  it("names the other bot in its color with a one-line excerpt", () => {
    const { toggle } = renderCard();
    expect(toggle.textContent).toBe("Messaged KODI · COOPost published: https://example.test/post");
    expect(toggle.querySelector(".rakazo-organic-avatar")).not.toBeNull();
    expect(toggle.querySelector("span.font-medium")?.getAttribute("style")).toContain("color");
    expect(toggle.querySelector(".truncate.text-foreground\\/75")).not.toBeNull();
  });

  it("expands to the whole message and collapses again", () => {
    const { toggle } = renderCard();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const card = container.querySelector('[data-testid="peer-message-card"]')!;
    expect(card.querySelector("strong")?.textContent).toBe("published");
    expect(toggle.textContent).toBe("Messaged KODI · COO");
    act(() => toggle.click());
    expect(card.querySelector("strong")).toBeNull();
  });

  it("opens the exchange only when given somewhere to go", () => {
    const onOpen = vi.fn();
    const { open, toggle } = renderCard({ onOpen, openLabel: "Open KODI · COO" });
    expect(open?.textContent).toBe("Open");
    act(() => open?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    expect(renderCard({ onOpen: undefined }).open).toBeNull();
  });

  it("stays a plain line when there is nothing to expand", () => {
    const { toggle } = renderCard({ text: "  " });
    expect(toggle.disabled).toBe(true);
    expect(toggle.hasAttribute("aria-expanded")).toBe(false);
  });

  it("animates the active bot glyph from its run status", () => {
    const html = renderToString(
      <ActiveBotGlyph
        bots={[{ botId: "research", color: "#14B8A6", status: "running" }]}
        label="Searching the web: injury news"
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-working="true"');
    expect(html).toContain("rakazo-organic-avatar-body-working");
  });
});
