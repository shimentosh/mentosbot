// @vitest-environment jsdom
import type { LinkPreviews } from "@rakazo/chat-ui/web";
import { LinkPreviewsContext } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/query/rpc";
import { MessageView } from "./message-view";

const skills = vi.hoisted(() => ({
  updateDraft: vi.fn(async () => ({})),
  save: vi.fn(async () => ({})),
  testRun: vi.fn(async () => ({ runId: "run" })),
}));
vi.mock("../../../lib/query/rpc", () => ({ rpc: { skills, artifacts: { get: vi.fn() } } }));

vi.mock("@lingui/core/macro", () => ({
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
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

type PeerBot = ComponentProps<typeof MessageView>["peerBot"];
const missingBot: PeerBot = () => undefined;
const existingBot: PeerBot = () => ({ color: "orange" });

const planner = (status: "created" | "archived" | "deleted" = "created") => ({
  kind: "child_bot" as const,
  botId: "child",
  name: "Planner",
  status,
});

function renderView(
  role: ThreadMessage["role"],
  blocks: ThreadMessage["blocks"],
  props: Partial<ComponentProps<typeof MessageView>> = {},
) {
  const message: ThreadMessage = {
    id: "message",
    threadId: "thread",
    seq: 1,
    role,
    createdAt: new Date().toISOString(),
    blocks,
  };
  act(() =>
    root.render(
      <MessageView
        rpc={rpc}
        artifactTarget={{ botId: "parent" }}
        canAnswer={false}
        canDismiss={false}
        message={message}
        onAnswer={vi.fn()}
        onOpenBot={vi.fn()}
        onOpenPeerMessages={vi.fn()}
        peerBot={existingBot}
        onRefresh={vi.fn()}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        callHoldsSpeaker={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        onReleaseComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn()}
        {...props}
      />,
    ),
  );
}

function renderMessage(
  blocks: ThreadMessage["blocks"],
  peerBot: PeerBot,
  mentions?: ReturnType<typeof planner>[],
) {
  const onOpenBot = vi.fn();
  renderView("bot", blocks, { mentions, onOpenBot, peerBot });
  const mention = container.querySelector<HTMLElement>('[data-testid="bot-mention"]')!;
  act(() => mention.click());
  return { mention, onOpenBot };
}

it("keeps a received peer marker off the user's side while user replies align to the end", () => {
  renderView("user", [
    { kind: "bot_message_received", fromBotId: "peer", fromBotName: "Atlas", text: "Done." },
  ]);
  const chip = container.querySelector('[data-testid="peer-receipt-chip"]');
  expect(chip?.textContent).toBe("Message from AtlasDone.");
  expect(chip?.closest(".items-end")).toBeNull();

  renderView("user", [{ kind: "text", text: "Thanks." }]);
  expect(container.querySelector(".items-end")?.textContent).toContain("Thanks.");
});

it("names a new bot inline in the reply, in its color", () => {
  const { mention, onOpenBot } = renderMessage(
    [{ kind: "text", text: "Planner is ready." }],
    existingBot,
    [planner()],
  );
  const bubble = container.querySelector('[data-testid="message-bot-bubble"]');
  expect(bubble?.contains(mention)).toBe(true);
  expect(bubble?.textContent).toBe("Planner is ready.");
  expect(mention.tagName).toBe("BUTTON");
  expect(mention.querySelector("span[dir]")?.getAttribute("style")).toContain("color");
  expect(onOpenBot).toHaveBeenCalledWith("child");
});

it("links another of the viewer's bots where a reply first names it, and opens its chat", () => {
  const onOpenBot = vi.fn();
  renderView("bot", [{ kind: "text", text: "Sent the posts to KODI. KODI will add them." }], {
    onOpenBot,
    peerBot: existingBot,
    linkBots: [
      { id: "kodi", name: "KODI" },
      { id: "quiet", name: "Archivist" },
    ],
  });
  const links = container.querySelectorAll<HTMLButtonElement>('[data-testid="bot-name-link"]');
  expect([...links].map((link) => link.textContent)).toEqual(["KODI"]);
  act(() => links[0]!.click());
  expect(onOpenBot).toHaveBeenCalledWith("kodi");
});

it("does not link a bot's own name, or names in a person's message", () => {
  const linkBots = [{ id: "kodi", name: "KODI" }];
  renderView("bot", [], {
    linkBots,
    message: {
      id: "own",
      threadId: "thread",
      seq: 1,
      role: "bot",
      botId: "kodi",
      createdAt: new Date().toISOString(),
      blocks: [{ kind: "text", text: "I am KODI." }],
    },
  });
  expect(container.querySelector('[data-testid="bot-name-link"]')).toBeNull();
  renderView("user", [{ kind: "text", text: "Ask KODI." }], { linkBots });
  expect(container.querySelector('[data-testid="bot-name-link"]')).toBeNull();
});

it("puts the bot first when the reply does not name it", () => {
  renderMessage([{ kind: "text", text: "Ready when you are." }], existingBot, [planner()]);
  expect(container.querySelector('[data-testid="message-bot-bubble"]')?.textContent).toBe(
    "Planner Ready when you are.",
  );
});

it.each([
  ["no longer exists", "created", missingBot],
  ["was deleted", "deleted", existingBot],
] as const)("keeps the name without color or link when the bot %s", (_, status, peerBot) => {
  const { mention, onOpenBot } = renderMessage(
    [{ kind: "text", text: "Planner is gone." }],
    peerBot,
    [planner(status)],
  );
  expect(mention.textContent).toBe("Planner");
  expect(mention.tagName).toBe("SPAN");
  expect(mention.querySelector("span[dir]")?.getAttribute("style")).toBeNull();
  expect(onOpenBot).not.toHaveBeenCalled();
});

it("shows an announcement with no reply yet on its own", () => {
  const { mention, onOpenBot } = renderMessage([planner()], existingBot);
  expect(mention.textContent).toBe("Planner");
  expect(onOpenBot).toHaveBeenCalledWith("child");
});

it("names the bot once across a reply's text blocks", () => {
  renderMessage(
    [
      { kind: "text", text: "Setting up." },
      { kind: "text", text: "Planner is ready." },
    ],
    existingBot,
    [planner()],
  );
  expect(container.querySelectorAll('[data-testid="bot-mention"]')).toHaveLength(1);
  expect(container.textContent).toContain("Setting up.");
  expect(container.textContent).toContain("Planner is ready.");
});

it("keeps an edit made after a save when the saved status arrives late", async () => {
  const draft = {
    kind: "skill_draft" as const,
    skillId: "skill",
    name: "Weekly report",
    goal: "Send the weekly report",
    playbook: {
      whenToUse: "Fridays",
      inputs: [],
      steps: ["Collect"],
      howToCheck: "",
      whatToReturn: "",
      approvalBoundaries: "",
      failureHandling: "",
    },
    status: "draft" as const,
  };
  const render = (block: typeof draft | (Omit<typeof draft, "status"> & { status: "saved" })) =>
    root.render(
      <MessageView
        rpc={rpc}
        artifactTarget={{ botId: "parent" }}
        canAnswer={false}
        canDismiss={false}
        message={{
          id: "message",
          threadId: "thread",
          seq: 1,
          role: "bot",
          createdAt: new Date().toISOString(),
          blocks: [block],
        }}
        onAnswer={vi.fn()}
        onOpenBot={vi.fn()}
        onOpenPeerMessages={vi.fn()}
        peerBot={existingBot}
        onRefresh={() => Promise.reject(new Error("offline"))}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        callHoldsSpeaker={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        onReleaseComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn()}
      />,
    );
  act(() => render(draft));
  const card = container.querySelector('[data-testid="skill-draft-card"]')!;
  const button = () => card.querySelector("button")!;
  await act(async () => button().click());
  expect(button().textContent).toBe("Saved");

  const input = card.querySelector("input")!;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  type("Edited");
  act(() => render({ ...draft, status: "saved" }));

  expect(input.value).toBe("Edited");
  expect(button().textContent).toBe("Save");

  // A different skill always loads its own fields.
  act(() => render({ ...draft, skillId: "other", name: "Other" }));
  expect(card.querySelector("input")!.value).toBe("Other");

  // A second save is not undone when the first save's status arrives after it.
  await act(async () => button().click());
  type("Newer");
  await act(async () => button().click());
  act(() => render({ ...draft, skillId: "other", name: "Other", status: "saved" }));
  expect(input.value).toBe("Newer");
  expect(button().textContent).toBe("Saved");
});

const ana = { id: "user-a", name: "Ana" };
const authored: ThreadMessage = {
  id: "message",
  threadId: "thread",
  seq: 1,
  role: "user",
  author: ana,
  blocks: [{ kind: "text", text: "Book the table" }],
  createdAt: new Date().toISOString(),
};

function renderAuthored(message: ThreadMessage, meId = "user-b") {
  renderView(message.role, message.blocks, { message, meId });
  const bubble = container.querySelector<HTMLElement>('[data-testid="message-user-bubble"]');
  if (!bubble?.parentElement) throw new Error("user bubble missing");
  return { bubble, row: bubble.parentElement };
}

it("names someone else's message and keeps it on the people side", () => {
  const { bubble, row } = renderAuthored(authored);

  expect(container.textContent).toBe("AnaBook the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-muted");
  expect(bubble.className).not.toContain("bg-chat-user");
});

function actionsLabel() {
  return container
    .querySelector('[role="group"][aria-label^="Message actions"]')
    ?.getAttribute("aria-label");
}

it("names the sender in another person's message actions", () => {
  renderAuthored(authored);

  expect(actionsLabel()).toContain("Ana");
});

it("leaves my own message actions without a sender name", () => {
  renderAuthored(authored, ana.id);

  expect(actionsLabel()).toMatch(/^Message actions, /);
  expect(actionsLabel()).not.toContain("Ana");
});

it("keeps my own message unnamed on the right", () => {
  const { bubble, row } = renderAuthored(authored, ana.id);

  expect(container.textContent).toBe("Book the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-chat-user");
});

it("names the person a reply quotes instead of saying You", () => {
  renderAuthored({
    ...authored,
    author: undefined,
    replyToMessageId: "parent",
    replyPreview: { role: "user", author: ana, text: "Find us a restaurant" },
  });

  expect(container.querySelector('[data-testid="reply-parent-preview"]')?.textContent).toContain(
    "Ana: Find us a restaurant",
  );
});

it("speaks the message it renders", () => {
  const onSpeak = vi.fn();
  renderView("bot", [{ kind: "text", text: "Hello" }], { onSpeak, voiceReady: true });
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Speak",
  );
  act(() => button?.click());
  expect(onSpeak).toHaveBeenCalledTimes(1);
  expect(onSpeak.mock.calls[0]?.[0]).toMatchObject({ id: "message" });
});

it("disables starting a read while a call holds the speaker, keeping stop available", () => {
  renderView("bot", [{ kind: "text", text: "Hello" }], {
    voiceReady: true,
    callHoldsSpeaker: true,
  });
  const startButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Speak this reply"]'),
  ];
  expect(startButtons().length).toBeGreaterThan(0);
  for (const button of startButtons()) expect(button.disabled).toBe(true);

  renderView("bot", [{ kind: "text", text: "Hello" }], {
    voiceReady: true,
    callHoldsSpeaker: true,
    speaking: true,
  });
  const stopButtons = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop speaking"]'),
  ];
  expect(stopButtons().length).toBeGreaterThan(0);
  for (const button of stopButtons()) expect(button.disabled).toBe(false);
});

it("opens one counted peer line without an inline reply toggle", () => {
  const open = vi.fn();
  renderView(
    "bot",
    [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text: "Request" }],
    {
      peerExchange: {
        peerBotId: "peer",
        peerBotName: "Researcher",
        count: 3,
        direction: "sent",
        entries: [],
      },
      onOpenPeerMessages: open,
    },
  );
  const line = container.querySelector<HTMLButtonElement>('[data-testid="peer-receipt-chip"]');
  expect(line?.textContent).toBe("3 messages with ResearcherRequest");
  expect(container.querySelector('[data-testid="peer-replies-toggle"]')).toBeNull();
  act(() => line?.click());
  expect(open).not.toHaveBeenCalled();
  const openButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open Researcher"]',
  );
  act(() => openButton?.click());
  expect(open).toHaveBeenCalledWith({ peerBotId: "peer", peerBotName: "Researcher" });
});

it("shows back-to-back messages with several bots as one line, with an Open for each", () => {
  const open = vi.fn();
  const entry = (messageId: string, peerBotId: string, peerBotName: string, text: string) => ({
    messageId,
    peerBotId,
    peerBotName,
    direction: "received" as const,
    text,
  });
  renderView(
    "user",
    [{ kind: "bot_message_received", fromBotId: "x", fromBotName: "Writer", text: "Posted" }],
    {
      peerExchange: {
        peerBotId: "x",
        peerBotName: "Writer",
        count: 2,
        direction: "received",
        entries: [entry("m1", "x", "Writer", "Posted"), entry("m2", "y", "Scout", "Found five")],
      },
      onOpenPeerMessages: open,
    },
  );
  const line = container.querySelector<HTMLButtonElement>('[data-testid="peer-receipt-chip"]');
  expect(line?.textContent).toBe("Messages with Writer and ScoutScout: Found five");
  act(() => line?.click());
  const openScout = container.querySelector<HTMLButtonElement>('button[aria-label="Open Scout"]');
  act(() => openScout?.click());
  expect(open).toHaveBeenCalledWith({ peerBotId: "y", peerBotName: "Scout" });
});

it("shows a group handoff as a card with nothing to open", () => {
  renderView(
    "bot",
    [{ kind: "handoff", fromBotId: "atlas", toBotId: "ledger", text: "Budget check" }],
    {
      artifactTarget: { groupId: "group" },
      memberName: (botId) => (botId === "atlas" ? "Atlas" : "Ledger"),
    },
  );
  const card = container.querySelector('[data-testid="peer-message-card"]');
  expect(card?.textContent).toBe("Atlas handed off to LedgerBudget check");
  expect(card?.querySelector('button[aria-label^="Open"]')).toBeNull();
});

it("opens no exchange from a group chat, which has no thread of its own to read it from", () => {
  renderView(
    "bot",
    [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text: "Request" }],
    { artifactTarget: { groupId: "group" } },
  );
  expect(container.querySelector('[data-testid="peer-receipt-chip"]')?.textContent).toBe(
    "Messaged ResearcherRequest",
  );
  expect(container.querySelector('button[aria-label^="Open"]')).toBeNull();
});

it("sends a settings Undo through the chat's space client", async () => {
  const spaceRpc = { bots: { update: vi.fn(async () => ({})) } };
  renderView(
    "bot",
    [
      {
        kind: "ask",
        text: "Settings updated",
        status: "answered",
        settingsUpdate: {
          botId: "bot-1",
          before: { modelProvider: null, modelId: null, thinkingLevel: null },
          after: { modelProvider: "google", modelId: "gemini-3.8-flash", thinkingLevel: "high" },
        },
      },
    ],
    { rpc: spaceRpc as never },
  );
  const undo = [...container.querySelectorAll("button")].find((b) => b.textContent === "Undo");
  await act(async () => undo?.click());
  expect(spaceRpc.bots.update).toHaveBeenCalledTimes(1);
});

it("draws a card without a title the way it always has", () => {
  renderView("bot", [{ kind: "card", lines: [{ k: "Report", v: "Q3 summary" }] }]);
  expect(container.querySelector('[data-testid="status-card"]')).toBeNull();
  expect(container.textContent).toContain("✓Report→Q3 summary");
});

it("draws a status card with its facts and only safe links", () => {
  renderView("bot", [
    {
      kind: "card",
      title: "Post published",
      lines: [
        { k: "Account", v: "@handle" },
        { k: "Time", v: "3:27 AM" },
      ],
      links: [{ label: "View post", url: "https://social.example.test/p/1" }],
    },
  ]);
  const card = container.querySelector('[data-testid="status-card"]')!;
  expect(card.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Done");
  expect(card.textContent).toContain("Post published");
  expect([...card.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([
    "Account",
    "Time",
  ]);
  expect([...card.querySelectorAll("dd")].map((value) => value.textContent)).toEqual([
    "@handle",
    "3:27 AM",
  ]);
  const link = card.querySelector("a")!;
  expect(link.textContent).toBe("View post");
  expect(link.getAttribute("href")).toBe("https://social.example.test/p/1");
  expect(link.getAttribute("target")).toBe("_blank");

  renderView("bot", [
    {
      kind: "card",
      title: "Email not sent",
      status: "failed",
      lines: [],
      links: [{ label: "Open", url: "javascript:alert(1)" }],
    },
  ]);
  const failed = container.querySelector('[data-testid="status-card"]')!;
  expect(failed.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Failed");
  expect(failed.querySelector("a")).toBeNull();
  expect(failed.querySelector("dl")).toBeNull();
});

const preview = {
  title: "A post",
  description: "What it says",
  siteName: "Example",
  image: "data:image/jpeg;base64,AAAA",
};

function renderWithPreviews(load: LinkPreviews["load"], blocks: ThreadMessage["blocks"], id = "m") {
  act(() =>
    root.render(
      <LinkPreviewsContext.Provider value={{ load }}>
        <MessageView
          rpc={rpc}
          artifactTarget={{ botId: "parent" }}
          canAnswer={false}
          canDismiss={false}
          message={{
            id,
            threadId: "thread",
            seq: 1,
            role: "bot",
            createdAt: new Date().toISOString(),
            blocks,
          }}
          onAnswer={vi.fn()}
          onOpenBot={vi.fn()}
          onOpenPeerMessages={vi.fn()}
          peerBot={existingBot}
          onRefresh={vi.fn()}
          onBotChanged={vi.fn()}
          onAddRoutine={vi.fn()}
          voiceReady={false}
          speaking={false}
          callHoldsSpeaker={false}
          onSpeak={vi.fn()}
          onOpenComputer={vi.fn()}
          onReleaseComputer={vi.fn()}
          showToolActivity={false}
          onReply={vi.fn()}
          onMarkUnread={vi.fn()}
          onReact={vi.fn()}
        />
      </LinkPreviewsContext.Provider>,
    ),
  );
}

it("draws a card for a link a reply shares once the server has read it", async () => {
  const load = vi.fn<LinkPreviews["load"]>(async () => ({ preview }));
  renderWithPreviews(load, [{ kind: "text", text: "Posted: https://site.example.test/post/1" }]);
  await act(async () => undefined);
  expect(load).toHaveBeenCalledWith("https://site.example.test/post/1");
  const card = container.querySelector<HTMLAnchorElement>('[data-testid="link-preview"]');
  expect(card?.href).toBe("https://site.example.test/post/1");
  expect(card?.textContent).toContain("A post");
  expect(card?.textContent).toContain("What it says");
  expect(card?.textContent).toContain("Example");
  expect(card?.querySelector("img")?.getAttribute("src")).toBe(preview.image);
});

it("never looks up a link whose address is hidden behind its label", async () => {
  const load = vi.fn<LinkPreviews["load"]>(async () => ({ preview }));
  renderWithPreviews(load, [
    { kind: "text", text: "[Read the post](https://hidden.example.test/post?ref=1)" },
  ]);
  await act(async () => undefined);
  expect(load).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
});

it("draws nothing while the page is read, or when it has no preview", async () => {
  let answer!: (value: { preview: null }) => void;
  const load = vi.fn<LinkPreviews["load"]>(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  renderWithPreviews(load, [{ kind: "text", text: "https://none.example.test/a" }]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
  await act(async () => answer({ preview: null }));
  expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
});

it("looks nothing up while a reply is still streaming", async () => {
  const load = vi.fn<LinkPreviews["load"]>(async () => ({ preview }));
  renderWithPreviews(
    load,
    [{ kind: "progress", text: "Posted: https://stream.example.test/po" }],
    "progress:run",
  );
  await act(async () => undefined);
  expect(load).not.toHaveBeenCalled();
});

it("stops a background helper from its saved running card, never a turn's live one", () => {
  const spaceRpc = { threads: { stopHelper: vi.fn(async () => ({ ok: true })) } };
  const helper = (id: string): ThreadMessage => ({
    id,
    threadId: "thread",
    seq: 1,
    role: "bot",
    botId: "bot-1",
    createdAt: new Date().toISOString(),
    blocks: [{ kind: "subagent", agentId: id, name: "scout", task: "venues", status: "running" }],
  });
  const stopButton = () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop");
  renderView("bot", [], { message: helper("subagent:live"), rpc: spaceRpc as never });
  expect(stopButton()).toBeUndefined();
  renderView("bot", [], { message: helper("card-1"), rpc: spaceRpc as never });
  act(() => stopButton()?.click());
  expect(spaceRpc.threads.stopHelper).toHaveBeenCalledExactlyOnceWith({
    botId: "bot-1",
    messageId: "card-1",
  });
});
