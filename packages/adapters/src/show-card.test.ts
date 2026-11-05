import { describe, expect, it } from "vitest";
import { showCardBlock } from "./show-card.js";

describe("showCardBlock", () => {
  it("builds the card and ignores blank optional fields", () => {
    expect(
      showCardBlock(
        {
          title: "Meeting booked",
          status: "",
          fields: [{ label: "When", value: "Tue 10:00" }],
          links: null,
        },
        [],
      ),
    ).toEqual({
      block: {
        kind: "card",
        title: "Meeting booked",
        status: "done",
        lines: [{ k: "When", v: "Tue 10:00" }],
      },
    });
  });

  it("explains invalid input", () => {
    const result = showCardBlock(
      { title: "Sent", links: [{ label: "Open", url: "ftp://example.test" }] },
      [],
    );
    expect(result).toEqual({ error: expect.stringContaining("links") });
  });

  it("refuses a card that carries a secret", () => {
    expect(
      showCardBlock({ title: "Key saved", fields: [{ label: "Key", value: "sk-test-123456" }] }, [
        "sk-test-123456",
      ]),
    ).toEqual({ error: "The card contains a secret value; nothing was shown." });
  });
});
