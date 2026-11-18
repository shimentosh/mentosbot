import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_MEMORY_MAX_BYTES } from "@rakazo/contracts";
import { byteLength } from "./utf8.js";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

/** `forget_memory` is offered only when the provider implements its optional forget verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => semanticMemoryForgets || tool.name !== "forget_memory")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

/** Where a fact saved without a topic goes once the memory has topics. */
export const MEMORY_DEFAULT_TOPIC = "Notes";
const MAX_TOPIC_CHARS = 40;

const isTopicHeading = (line: string) => line.startsWith("## ");

/** A topic as its heading line: one short line, with nothing that could start another heading. */
function topicHeading(topic: string): string | undefined {
  const name = topic
    .replace(/[\r\n#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TOPIC_CHARS)
    .trim();
  return name ? `## ${name}` : undefined;
}

/**
 * Adds a fact, under its topic's heading when one is given or the memory already has topics,
 * so related facts stay together. A fact already saved is not added again.
 */
export function appendMemoryFact(existing: string, fact: string, topic = ""): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  const lines = current ? current.split("\n") : [];
  const heading =
    topicHeading(topic) ?? (lines.some(isTopicHeading) ? `## ${MEMORY_DEFAULT_TOPIC}` : undefined);
  if (!heading) {
    return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
  }
  const at = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (at === -1) return `${current ? `${current}\n\n` : ""}${heading}\n${comparableFact}\n`;
  // The topic ends at the next heading; the fact goes after its last entry.
  let end = lines.findIndex((line, index) => index > at && isTopicHeading(line));
  if (end === -1) end = lines.length;
  while (end > at + 1 && !lines[end - 1]!.trim()) end -= 1;
  lines.splice(end, 0, comparableFact);
  return `${lines.join("\n")}\n`;
}

/** Drops the headings of topics left with no entries. */
function withoutEmptyTopics(content: string): string {
  const lines = content.split("\n");
  const kept = lines.filter((line, index) => {
    if (!isTopicHeading(line)) return true;
    const next = lines.slice(index + 1).find((later) => later.trim());
    return next !== undefined && !isTopicHeading(next);
  });
  return kept.length === lines.length
    ? content
    : `${kept
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()}\n`.replace(/^\n$/, "");
}

export type MemoryEdit = { content: string } | { error: string; entries: string[] };

/**
 * Adds a fact, or with `oldText` replaces (or, given an empty fact, removes) the
 * lines holding its one match. A save that would grow the document past the cap
 * is refused with the entries, so the bot consolidates instead of losing notes.
 * `topic` files a new fact under that heading.
 */
export function editMemory(
  existing: string,
  fact: string,
  oldText = "",
  maxBytes = BOT_MEMORY_MAX_BYTES,
  topic = "",
): MemoryEdit {
  const target = oldText.trim().replace(/\r\n/g, "\n");
  let content = existing;
  if (!target) {
    content = appendMemoryFact(existing, fact, topic);
  } else {
    const current = existing.replace(/\r\n/g, "\n");
    // An entry is the line or lines a match touches, so repeats within one line count once.
    const starts = new Set<number>();
    for (let at = current.indexOf(target); at !== -1; at = current.indexOf(target, at + 1))
      starts.add(current.lastIndexOf("\n", at - 1) + 1);
    if (starts.size !== 1) {
      const firstLine = target.split("\n")[0]!;
      return {
        error:
          starts.size === 0
            ? "No entry contains old_text. Copy it exactly from one of these entries."
            : "old_text matches more than one entry. Quote more of the one to change.",
        entries: entriesOf(current).filter((line) => starts.size === 0 || line.includes(firstLine)),
      };
    }
    const index = current.indexOf(target);
    const start = [...starts][0]!;
    const lineEnd = current.indexOf("\n", index + target.length);
    const end = lineEnd === -1 ? current.length : lineEnd;
    const next = fact.trim().replace(/\r\n/g, "\n");
    content = next
      ? `${current.slice(0, start)}${next}${current.slice(end)}`
      : withoutEmptyTopics(
          `${current.slice(0, start)}${current.slice(lineEnd === -1 ? end : end + 1)}`,
        );
  }
  const bytes = byteLength(content);
  if (bytes > maxBytes && bytes > byteLength(existing)) {
    return {
      error: `Memory is full (${maxBytes} bytes). Make room by merging, shortening or removing entries with old_text, then save again.`,
      entries: entriesOf(existing),
    };
  }
  return { content };
}

function entriesOf(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
}
