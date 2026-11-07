// @vitest-environment jsdom

import type { Approval } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ approvals: vi.fn(), answer: vi.fn() }));
const tabs = vi.hoisted(() => ({ change: (_value: string): void => undefined }));
vi.mock("../lib/rpc", () => ({
  rpc: { inbox: { approvals: api.approvals } },
  rpcForSpace: () => ({ threads: { answer: api.answer } }),
  selectedSpaceId: () => "space-1",
}));
vi.mock("../lib/query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    useQueryUserId: () => "user-1",
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, other }: { value: number; other: string }) =>
      other.replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = (props: ComponentProps<"button">) => <button type="button" {...props} />;
  return {
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    BotAvatar: () => <i />,
    Button,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    ListSearchInput: () => null,
    NativeSelect: Container,
    NativeSelectOption: Container,
    SectionHeading: Container,
    Spinner: () => null,
    Tabs: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange: (value: string) => void;
    }) => {
      tabs.change = onValueChange;
      return <div>{children}</div>;
    },
    TabsList: Container,
    TabsTrigger: ({ value, children }: { value: string; children?: ReactNode }) => (
      <button type="button" onClick={() => tabs.change(value)}>
        {children}
      </button>
    ),
    buttonVariants: () => "",
  };
});
vi.mock("../components/AskCard", () => ({
  AskCard: ({ block }: { block: { text: string } }) => <p data-ask>{block.text}</p>,
}));
vi.mock("./ActivityList", () => ({ ActivityList: () => null }));
vi.mock("./shell/message-cards", () => ({ ArtifactImage: () => null }));

import { ApprovalsOverlay } from "./ApprovalsOverlay";

function approval(runId: string, botId: string, block: Record<string, unknown>): Approval {
  return {
    runId,
    spaceId: "space-1",
    spaceName: "Personal",
    bot: { id: botId, name: botId, color: "blue", avatarSet: "organic" },
    threadId: `thread-${runId}`,
    groupId: null,
    at: new Date().toISOString(),
    ask: { messageId: `message-${runId}`, block: { kind: "ask", status: "pending", ...block } },
  } as Approval;
}

const allowDeny = [
  { id: "allow", label: "Allow once" },
  { id: "deny", label: "Deny" },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("approves every permission card at once and leaves questions to the person", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.approvals.mockResolvedValue([
    approval("post", "Poster", {
      text: "Post on LinkedIn?",
      approvalEffectId: "e1",
      actions: allowDeny,
    }),
    approval("send", "Mailer", {
      text: "Send the email?",
      approvalEffectId: "e2",
      actions: allowDeny,
    }),
    approval("pick", "Planner", {
      text: "Which day?",
      actions: [
        { id: "mon", label: "Monday" },
        { id: "tue", label: "Tuesday" },
      ],
    }),
  ]);
  api.answer.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ApprovalsOverlay bots={[]} groups={[]} onClose={vi.fn()} onOpenChat={vi.fn()} />,
      ),
    );
    await vi.waitFor(() => expect(container.querySelectorAll("[data-ask]")).toHaveLength(3));
    const button = (label: string) =>
      [...container.querySelectorAll("button")].filter((node) => node.textContent === label);

    await act(async () => button("Approve all")[0]!.click());
    expect(container.textContent).toContain("Approve 2 requests?");
    await act(async () => button("Approve all").at(-1)!.click());

    expect(api.answer).toHaveBeenCalledTimes(2);
    expect(api.answer).toHaveBeenCalledWith({
      botId: "Poster",
      runId: "post",
      messageId: "message-post",
      answer: "allow",
    });
    expect(api.answer).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "send", answer: "allow" }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows each bot's tracker page when a bot has one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.approvals.mockResolvedValue([]);
  const bot = (id: string, trackerUrl: string | null) =>
    ({ id, name: id, color: "blue", avatarSet: "organic", trackerUrl }) as never;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ApprovalsOverlay
          bots={[bot("Social", "https://example.test/social"), bot("Quiet", null)]}
          groups={[]}
          onClose={vi.fn()}
          onOpenChat={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector("iframe")).toBeNull();
    const trackers = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Trackers",
    )!;
    await act(async () => trackers.click());
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.test/social");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(container.textContent).not.toContain("Quiet");
  } finally {
    await act(async () => root.unmount());
  }
});
