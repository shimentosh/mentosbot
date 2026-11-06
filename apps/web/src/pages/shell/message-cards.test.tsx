// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ connectionId: "connection", authorizationUrl: null })),
  complete: vi.fn(async () => ({ status: "connected" })),
  mark: vi.fn(async () => ({ ok: true })),
  oauthBegin: vi.fn(async () => ({
    status: "authorization_required" as const,
    authorizationUrl: "https://identity.example.test/authorize",
  })),
  approve: vi.fn(async () => ({ ok: true })),
  artifact: vi.fn(async () => ({ mimeType: "image/png", contentBase64: btoa("png") })),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    connections: { begin: calls.begin, complete: calls.complete },
    onboarding: { appConnected: calls.mark },
    mcp: { oauth: { begin: calls.oauthBegin }, assignments: { approve: calls.approve } },
    artifacts: { get: calls.artifact },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { connectMcpOauth } from "../../lib/mcp-connect";
import { AppConnectCard, ArtifactImage, McpApprovalCard } from "./message-cards";

function popupFlow({ focused }: { focused: boolean }) {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(public name: string) {
      channels.push(this);
    }
  }
  // A popup on a COOP provider page reads as closed to the opener.
  const popup = { closed: true, close: vi.fn() };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  return { popup, channels };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("approves the bot after OAuth completes while a COOP popup keeps focus", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: false });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpApprovalCard
          botId="bot"
          threadId="thread"
          block={{
            kind: "mcp_approval",
            name: "Example",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://example.test/mcp",
            needsOAuth: true,
            status: "pending",
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls.approve).not.toHaveBeenCalled();
    await act(async () =>
      channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } } as MessageEvent),
    );
    expect(calls.approve).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      serverId: "server",
      threadId: "thread",
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels once the popup is closed and the app has focus again", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: true });
  const flow = connectMcpOauth("server");
  await vi.advanceTimersByTimeAsync(500);
  await expect(flow).resolves.toBe("cancelled");
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("authorizes a card in a normal chat and marks its thread connected", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AppConnectCard
          botId="bot"
          threadId="normal-chat"
          block={{
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "",
            logo: null,
            status: "pending",
          }}
        />,
      ),
    );
    expect(host.querySelector("button")?.textContent).toBe("Connect");
    await act(async () => host.querySelector("button")?.click());
    expect(calls.mark).toHaveBeenCalledWith({
      botId: "bot",
      threadId: "normal-chat",
      connectorId: "fake",
      provider: "gmail",
    });
    expect(host.textContent).toContain("Connected");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("downloads an opened chat image under its own name", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:image" }));
  const saved: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<ArtifactImage target={{ botId: "bot" }} artifactId="image" name="post.png" />),
    );
    const thumbnail = host.querySelector("button");
    await act(async () => thumbnail?.click());
    const download = document.querySelector<HTMLButtonElement>('[aria-label="Download post.png"]');
    await act(async () => download?.click());
    expect(saved).toEqual([{ href: "blob:image", download: "post.png" }]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("shows a loading image, then lets a failed one try again", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:image" }));
  let fail!: (error: Error) => void;
  calls.artifact.mockImplementationOnce(
    () => new Promise((_, reject) => (fail = reject)) as ReturnType<typeof calls.artifact>,
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<ArtifactImage target={{ botId: "bot" }} artifactId="flaky" name="chart.png" />),
    );
    expect(host.querySelector('[aria-label="Loading chart.png"]')).not.toBeNull();
    await act(async () => fail(new Error("offline")));
    expect(host.textContent).toContain("Could not load this file.");
    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => retry?.click());
    expect(host.querySelector('img[alt="chart.png"]')?.getAttribute("src")).toBe("blob:image");
  } finally {
    act(() => root.unmount());
  }
});
