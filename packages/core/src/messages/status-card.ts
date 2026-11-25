import type { CardBlock, CardStatus } from "@rakazo/contracts";
import { isCardLinkUrl } from "@rakazo/contracts";

const STATUS_GLYPHS: Record<CardStatus, string> = {
  done: "✓",
  pending: "◷",
  failed: "✕",
  info: "•",
};

/** A card's status; a titled card without one is a receipt. */
export function cardStatus(block: Pick<CardBlock, "status">): CardStatus {
  return block.status ?? "done";
}

export function cardStatusGlyph(block: Pick<CardBlock, "status">): string {
  return STATUS_GLYPHS[cardStatus(block)];
}

/** The card's links that are safe to open; stored links are checked again before rendering. */
export function cardLinks(block: Pick<CardBlock, "links">): NonNullable<CardBlock["links"]> {
  return (block.links ?? []).filter((link) => link.label.trim() && isCardLinkUrl(link.url));
}

/** One line for chat lists, reply lines and notifications: "✓ Post published". */
export function cardPreviewText(block: CardBlock): string {
  const title = block.title?.trim();
  if (title) return `${cardStatusGlyph(block)} ${title}`;
  return block.lines.map((line) => `${line.k}: ${line.v}`).join(", ");
}

/** The card as plain text, for channels that cannot draw it. */
export function cardPlainText(block: CardBlock): string {
  const title = block.title?.trim();
  const links = cardLinks(block);
  return [
    title ? `${cardStatusGlyph(block)} ${title}` : "",
    ...block.lines.map((line) => `${line.k}: ${line.v}`),
    ...links.map((link) => (links.length === 1 ? link.url : `${link.label}: ${link.url}`)),
  ]
    .filter(Boolean)
    .join("\n");
}
