import { describe, expect, it } from "vitest";
import { MessageBlock } from "./events.js";
import {
  CARD_FIELD_LIMIT,
  CARD_TITLE_MAX_LENGTH,
  cardBlockFromInput,
  isCardLinkUrl,
  ShowCardInput,
} from "./status-card.js";

describe("card block", () => {
  it("still parses a card stored before titles, statuses and links", () => {
    const legacy = { kind: "card", lines: [{ k: "Report", v: "Q3 summary" }] };
    expect(MessageBlock.parse(legacy)).toEqual(legacy);
  });

  it("parses a receipt card", () => {
    const receipt = {
      kind: "card",
      title: "Post published",
      status: "done",
      lines: [{ k: "Account", v: "@handle" }],
      links: [{ label: "View post", url: "https://social.example.test/p/1" }],
    };
    expect(MessageBlock.parse(receipt)).toEqual(receipt);
  });

  it("rejects a stored link that is not http or https", () => {
    const card = { kind: "card", title: "Done", lines: [] };
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "nope"]) {
      expect(MessageBlock.safeParse({ ...card, links: [{ label: "Open", url }] }).success).toBe(
        false,
      );
    }
  });
});

describe("isCardLinkUrl", () => {
  it("allows http and https links without credentials", () => {
    expect(isCardLinkUrl("https://example.test/a?b=1")).toBe(true);
    expect(isCardLinkUrl("http://example.test")).toBe(true);
    expect(isCardLinkUrl("https://user:pass@example.test")).toBe(false);
    expect(isCardLinkUrl("mailto:pat@example.test")).toBe(false);
    expect(isCardLinkUrl(`https://example.test/${"a".repeat(2_100)}`)).toBe(false);
  });
});

describe("ShowCardInput", () => {
  it("defaults to a done receipt and maps fields onto lines", () => {
    const input = ShowCardInput.parse({
      title: "  Post\n published ",
      fields: [{ label: "Account", value: "@handle" }],
      links: [{ label: "View post", url: " https://social.example.test/p/1 " }],
    });
    expect(cardBlockFromInput(input)).toEqual({
      kind: "card",
      title: "Post published",
      status: "done",
      lines: [{ k: "Account", v: "@handle" }],
      links: [{ label: "View post", url: "https://social.example.test/p/1" }],
    });
    expect(
      cardBlockFromInput(ShowCardInput.parse({ title: "Syncing", status: "pending" })),
    ).toEqual({ kind: "card", title: "Syncing", status: "pending", lines: [] });
  });

  it("rejects input outside its limits", () => {
    const bad = [
      {},
      { title: "" },
      { title: "   " },
      { title: "x".repeat(CARD_TITLE_MAX_LENGTH + 1) },
      { title: "Done", status: "ok" },
      {
        title: "Done",
        fields: Array.from({ length: CARD_FIELD_LIMIT + 1 }, (_, i) => ({
          label: `k${i}`,
          value: "v",
        })),
      },
      { title: "Done", fields: [{ label: "Account", value: "x".repeat(121) }] },
      { title: "Done", links: [{ label: "Open", url: "javascript:alert(1)" }] },
      {
        title: "Done",
        links: [1, 2, 3].map((n) => ({ label: `Link ${n}`, url: `https://example.test/${n}` })),
      },
      { title: "Done", extra: true },
    ];
    for (const input of bad)
      expect(ShowCardInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});
