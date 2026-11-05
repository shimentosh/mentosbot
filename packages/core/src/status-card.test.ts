import type { CardBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import { previewMessageText } from "./message-replies.js";
import { speechFromBlocks } from "./speech-text.js";
import { cardLinks, cardPlainText, cardPreviewText } from "./status-card.js";

const receipt: CardBlock = {
  kind: "card",
  title: "Post published",
  lines: [
    { k: "Account", v: "@handle" },
    { k: "Time", v: "3:27 AM" },
  ],
  links: [{ label: "View post", url: "https://social.example.test/p/1" }],
};
const legacy: CardBlock = { kind: "card", lines: [{ k: "Due", v: "Monday" }] };

describe("status card text", () => {
  it("previews a card as its status glyph and title", () => {
    expect(cardPreviewText(receipt)).toBe("✓ Post published");
    expect(cardPreviewText({ ...receipt, status: "pending" })).toBe("◷ Post published");
    expect(cardPreviewText({ ...receipt, status: "failed" })).toBe("✕ Post published");
    expect(cardPreviewText({ ...receipt, status: "info" })).toBe("• Post published");
    expect(cardPreviewText(legacy)).toBe("Due: Monday");
  });

  it("writes a card as plain text for channels that cannot draw it", () => {
    expect(cardPlainText(receipt)).toBe(
      "✓ Post published\nAccount: @handle\nTime: 3:27 AM\nhttps://social.example.test/p/1",
    );
    expect(
      cardPlainText({
        ...receipt,
        lines: [],
        links: [
          { label: "Doc", url: "https://docs.example.test/1" },
          { label: "Sheet", url: "https://sheets.example.test/1" },
        ],
      }),
    ).toBe(
      "✓ Post published\nDoc: https://docs.example.test/1\nSheet: https://sheets.example.test/1",
    );
    expect(cardPlainText(legacy)).toBe("Due: Monday");
  });

  it("drops links that are not safe to open", () => {
    const card = {
      ...receipt,
      links: [
        { label: "Bad", url: "javascript:alert(1)" },
        { label: "Good", url: "https://example.test" },
      ],
    };
    expect(cardLinks(card)).toEqual([{ label: "Good", url: "https://example.test" }]);
  });

  it("shows the card in reply previews, speech and the bot's history", () => {
    expect(
      previewMessageText(
        { role: "bot", blocks: [receipt] },
        { photo: "Photo", attachment: "Attachment", message: "Message" },
      ),
    ).toBe("✓ Post published");
    expect(speechFromBlocks([receipt])).toBe("Post published. Account: @handle. Time: 3:27 AM");
    expect(blocksToAgentHistoryText([receipt])).toBe(
      "[card: ✓ Post published; Account: @handle; Time: 3:27 AM; https://social.example.test/p/1]",
    );
  });
});
