// @vitest-environment jsdom
import type { Inbox, InboxEntry } from "@rakazo/contracts";
import { groupRecent } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InboxList } from "./notification-bell";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    value === 1 ? one : other.replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => <span data-avatar="" />,
  Button: () => null,
  Popover: () => null,
  PopoverContent: () => null,
  PopoverTrigger: () => null,
}));
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "1m ago" }));
vi.mock("../../lib/rpc", () => ({ rpc: {}, selectedSpaceId: () => "space-1" }));
vi.mock("../../lib/query", () => ({ queryClient: {}, useQueryUserId: () => "user-1" }));

function entry(overrides: Partial<InboxEntry> & Pick<InboxEntry, "id" | "kind">): InboxEntry {
  return {
    spaceId: "space-1",
    spaceName: "Personal",
    bot: { id: "bot-ada", name: "Ada", color: "blue", avatarSet: "organic" },
    threadId: "thread-1",
    groupId: null,
    at: new Date().toISOString(),
    read: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
afterEach(() => container?.remove());

async function render(inbox: Inbox | undefined, onOpen = vi.fn(), onShowActivity = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <InboxList inbox={inbox} onOpen={onOpen} onShowActivity={onShowActivity} />,
    );
  });
  return { onOpen, onShowActivity };
}

it("puts what needs the person first, then recent work, one line per bot's run of it", async () => {
  const scout = { id: "bot-scout", name: "Scout", color: "green", avatarSet: "organic" as const };
  const { onOpen } = await render({
    spaceId: "space-1",
    needsYou: [
      entry({ id: "run:1", kind: "approval" }),
      entry({ id: "run:2", kind: "takeover", bot: scout, spaceId: "space-2", spaceName: "Work" }),
    ],
    recent: [
      entry({ id: "n1", kind: "completion", read: true }),
      entry({ id: "n2", kind: "completion" }),
      entry({ id: "n3", kind: "failure", bot: scout }),
    ],
    unread: 2,
  });
  const sections = [...container.querySelectorAll("section")].map((section) => [
    section.querySelector("h3")?.textContent,
    [...section.querySelectorAll("li")].map((item) => item.textContent),
  ]);
  expect(sections).toEqual([
    ["Needs you", ["AdaNeeds your approval1m ago", "ScoutWorkNeeds you on the screen1m ago"]],
    ["Recent", ["AdaFinished 2 tasks1m ago", "ScoutFailed1m ago"]],
  ]);
  await act(async () => container.querySelector<HTMLButtonElement>("li button")!.click());
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "run:1" }));
});

it("says when there is nothing, and always leads to all activity", async () => {
  const { onShowActivity } = await render({
    spaceId: "space-1",
    needsYou: [],
    recent: [],
    unread: 0,
  });
  expect(container.textContent).toContain("You're all caught up");
  const all = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "All activity",
  )!;
  await act(async () => all.click());
  expect(onShowActivity).toHaveBeenCalled();
});

it("keeps a group unread while any of its work is", () => {
  const grouped = groupRecent([
    entry({ id: "a", kind: "completion", read: true }),
    entry({ id: "b", kind: "completion", read: false }),
    entry({ id: "c", kind: "failure", read: true }),
  ]);
  expect(grouped.map(({ entry: first, count, read }) => [first.id, count, read])).toEqual([
    ["a", 2, false],
    ["c", 1, true],
  ]);
});
