import type { MessageBlock } from "@rakazo/contracts";
import { clampBotMessage } from "../bots/bot-messages.js";
import type { FoldedTranscript } from "../messages/message-visibility.js";

/** One message a bot sent another, or received from one, inside an exchange line. */
export type PeerExchangeEntry = {
  messageId: string;
  peerBotId: string;
  peerBotName: string;
  direction: "sent" | "received";
  text: string;
};

export type PeerExchange = {
  peerBotId: string;
  peerBotName: string;
  count: number;
  direction: "sent" | "received";
  /** Every bot message the line stands for, oldest first; it may span several bots. */
  entries: PeerExchangeEntry[];
};

type Message = {
  id: string;
  runId?: string;
  role?: string;
  blocks: readonly MessageBlock[];
};

/** Content shown in the read-only peer conversation, not tools or activity. */
export function isPeerReplyBlock(block: MessageBlock) {
  return (
    block.kind === "text" ||
    block.kind === "file" ||
    block.kind === "image" ||
    block.kind === "chart" ||
    block.kind === "page"
  );
}

function peerReceipt(blocks: readonly MessageBlock[]) {
  const block = blocks.find(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (block?.kind === "bot_message_sent")
    return { peerBotId: block.toBotId, peerBotName: block.toBotName, direction: "sent" as const };
  if (block?.kind === "bot_message_received")
    return {
      peerBotId: block.fromBotId,
      peerBotName: block.fromBotName,
      direction: "received" as const,
    };
  return undefined;
}

/** Match exact observable payloads within one run and peer, never similar prose across runs. */
export function unreturnedPeerReplies<T extends Message>(
  transcript: FoldedTranscript<T>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  const receipts = new Map<string, Map<string, Map<string, number>>>();
  for (const message of transcript.messages) {
    if (!message.runId) continue;
    for (const block of message.blocks) {
      if (block.kind !== "bot_message_sent") continue;
      let peers = receipts.get(message.runId);
      if (!peers) {
        peers = new Map();
        receipts.set(message.runId, peers);
      }
      let counts = peers.get(block.toBotId);
      if (!counts) {
        counts = new Map();
        peers.set(block.toBotId, counts);
      }
      const text = clampBotMessage(block.text);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  for (const marker of transcript.messages) {
    const peer = peerReceipt(marker.blocks);
    const replies = transcript.folded.get(marker.id);
    if (!peer || !replies) continue;
    const echoes = marker.runId ? receipts.get(marker.runId)?.get(peer.peerBotId) : undefined;
    result.set(
      marker.id,
      replies.filter((reply) => {
        if (reply.role !== "bot") return false;
        const content = reply.blocks.filter(isPeerReplyBlock);
        if (!content.length) return false;
        // Attachments are not represented by a text echo.
        if (content.some((b) => b.kind !== "text")) return true;
        const text = clampBotMessage(
          content.map((b) => (b.kind === "text" ? b.text : "")).join("\n"),
        );
        const count = echoes?.get(text) ?? 0;
        if (!count) return true;
        echoes?.set(text, count - 1);
        return false;
      }),
    );
  }
  return result;
}

function peerEntries(message: Message): PeerExchangeEntry[] {
  return message.blocks.flatMap((block): PeerExchangeEntry[] =>
    block.kind === "bot_message_sent"
      ? [
          {
            messageId: message.id,
            peerBotId: block.toBotId,
            peerBotName: block.toBotName,
            direction: "sent",
            text: block.text,
          },
        ]
      : block.kind === "bot_message_received"
        ? [
            {
              messageId: message.id,
              peerBotId: block.fromBotId,
              peerBotName: block.fromBotName,
              direction: "received",
              text: block.text,
            },
          ]
        : [],
  );
}

/** The bots an exchange line involves, in the order they first appear, by their latest name. */
export function peerExchangeBots(exchange: PeerExchange): { id: string; name: string }[] {
  const names = new Map<string, string>();
  for (const entry of exchange.entries) {
    names.delete(entry.peerBotId);
    names.set(entry.peerBotId, entry.peerBotName);
  }
  const order = [...new Set(exchange.entries.map((entry) => entry.peerBotId))];
  return order.map((id) => ({ id, name: names.get(id)! }));
}

/** The bots' names as one phrase: "Ana", "Ana and Ben", "Ana, Ben and Cy". */
export function peerExchangeNames(bots: readonly { name: string }[]): string {
  const names = bots.map((bot) => bot.name);
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Project only visible rows; callers remove invisible tool/reaction rows before grouping.
 * Back-to-back bot messages share one line even across bots, so a manager that asks three bots
 * and hears back from them shows one line, not six.
 */
export function peerExchangeLines<T extends Message>(transcript: FoldedTranscript<T>) {
  const lines = new Map<string, PeerExchange>();
  const lineOf = new Map<string, string>();
  const unreturned = unreturnedPeerReplies(transcript);
  let previous: PeerExchange | undefined;
  let firstId: string | undefined;
  for (const message of transcript.messages) {
    const receipt = peerReceipt(message.blocks);
    if (!receipt) {
      previous = undefined;
      continue;
    }
    const count =
      message.blocks.filter(
        (b) => b.kind === "bot_message_sent" || b.kind === "bot_message_received",
      ).length + (unreturned.get(message.id)?.length ?? 0);
    if (previous && firstId) {
      if (previous.peerBotId === receipt.peerBotId) previous.peerBotName = receipt.peerBotName;
      previous.count += count;
      previous.entries.push(...peerEntries(message));
    } else {
      firstId = message.id;
      previous = { ...receipt, count, entries: peerEntries(message) };
      lines.set(firstId, previous);
    }
    lineOf.set(message.id, firstId);
  }
  return { lines, lineOf };
}

/** The final translation decides avatar placement, including locales with trailing words. */
export function splitPeerLabel(label: string, peerName: string) {
  const index = peerName ? label.lastIndexOf(peerName) : -1;
  return index < 0
    ? { before: "", name: "", after: label }
    : {
        before: label.slice(0, index),
        name: peerName,
        after: label.slice(index + peerName.length),
      };
}
