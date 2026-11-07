// @vitest-environment jsdom

import type { Approval } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ approvals: vi.fn(), answer: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { inbox: { approvals: api.approvals } },
  rpcForSpace: () => ({ threads: { answer: api.answer } }),
  selectedSpaceId: () => "space-1",
}));
vi.mock("../../lib/query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    useQueryUserId: () => "user-1",
  };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => <i />,
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));
vi.mock("../../components/AskCard", () => ({
  AskCard: ({
    block,
    onAnswer,
  }: {
    block: { text: string };
    onAnswer: (text: string) => Promise<void>;
  }) => (
    <button type="button" data-ask onClick={() => void onAnswer("choice-1")}>
      {block.text}
    </button>
  ),
}));
vi.mock("./message-cards", () => ({ ArtifactImage: () => null }));

import { DelegatedCards } from "./delegated-cards";

function approval(runId: string, botId: string, requestedByBotId: string | null): Approval {
  return {
    runId,
    spaceId: "space-1",
    spaceName: "Personal",
    bot: { id: botId, name: botId, color: "blue", avatarSet: "organic" },
    threadId: `thread-${runId}`,
    groupId: null,
    at: new Date().toISOString(),
    ask: {
      messageId: `message-${runId}`,
      block: { kind: "ask", status: "pending", text: `Publish for ${runId}?` },
    },
    requestedByBotId,
  } as Approval;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows and answers the cards of bots this bot handed work to, in this chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.approvals.mockResolvedValue([
    approval("x-replies", "noor-x", "noor-social"),
    approval("other-chain", "noor-linkedin", "someone-else"),
    approval("own-card", "noor-social", null),
  ]);
  api.answer.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DelegatedCards botId="noor-social" onOpen={vi.fn()} />));
    await vi.waitFor(() => expect(container.querySelectorAll("[data-ask]")).toHaveLength(1));
    const card = container.querySelector<HTMLButtonElement>("[data-ask]")!;
    expect(card.textContent).toBe("Publish for x-replies?");

    await act(async () => card.click());
    expect(api.answer).toHaveBeenCalledWith({
      botId: "noor-x",
      runId: "x-replies",
      messageId: "message-x-replies",
      answer: "choice-1",
    });
  } finally {
    act(() => root.unmount());
  }
});

it("shows nothing when no delegated card waits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.approvals.mockResolvedValue([approval("own-card", "noor-social", null)]);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DelegatedCards botId="noor-social" onOpen={vi.fn()} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.querySelector("[data-testid='delegated-cards']")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
