import type { InboxEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { bellRoute, inboxRows } from "./bell";

const entry = (overrides: Partial<InboxEntry> & Pick<InboxEntry, "id" | "kind">): InboxEntry => ({
  spaceId: "space-1",
  spaceName: "Personal",
  bot: { id: "bot-1", name: "Ada", color: "blue", avatarSet: "organic" },
  threadId: "thread-1",
  groupId: null,
  at: new Date().toISOString(),
  read: false,
  ...overrides,
});

describe("the bell on mobile", () => {
  it("lists what needs the person first, then grouped recent work", () => {
    const rows = inboxRows(
      {
        spaceId: "space-1",
        needsYou: [entry({ id: "run:1", kind: "approval" })],
        recent: [
          entry({ id: "a", kind: "completion" }),
          entry({ id: "b", kind: "completion", read: true }),
        ],
        unread: 1,
      },
      { needsYou: "Needs you", recent: "Recent" },
    );
    expect(
      rows.map((row) => (row.type === "header" ? row.title : [row.key, row.count, row.highlight])),
    ).toEqual(["Needs you", ["run:1", 1, true], "Recent", ["a", 2, true]]);
    expect(
      inboxRows(
        { spaceId: "s", needsYou: [], recent: [], unread: 0 },
        { needsYou: "", recent: "" },
      ),
    ).toEqual([]);
  });

  it("opens the chat in its own Space", () => {
    expect(bellRoute(entry({ id: "n", kind: "completion", spaceId: "space-2" }))).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", spaceId: "space-2", name: "Ada" },
    });
    expect(bellRoute(entry({ id: "g", kind: "failure", groupId: "group-1" }))).toEqual({
      pathname: "/group-thread",
      params: { groupId: "group-1", spaceId: "space-1" },
    });
  });
});
