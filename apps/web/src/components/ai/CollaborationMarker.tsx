import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { BotAvatarSet } from "@rakazo/contracts";
import { plainTextFromMarkdown, splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar, resolvePersonaColorDef } from "@rakazo/ui-web";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CornerUpRight,
} from "lucide-react";
import { useState } from "react";

const GLYPHS = {
  sent: ArrowUpRight,
  received: ArrowDownLeft,
  exchange: ArrowLeftRight,
  handoff: CornerUpRight,
};

/** One bot's message in a line that spans several bots. */
export interface PeerMessageEntry {
  key: string;
  direction: "sent" | "received";
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  peerName: string;
  text: string;
  openLabel?: string;
  onOpen?: () => void;
}

/**
 * What one bot sent another, as one quiet line: who, and a one-line excerpt. The line opens the
 * whole exchange when the viewer can see it, and otherwise expands in place. While the other bot
 * is still working on it, the excerpt says so. Given `entries` from several bots, the line names
 * them all and expands to one row per message, each opening its bot.
 */
export function PeerMessageCard({
  direction,
  color,
  avatarSet,
  identity,
  label,
  peerName,
  text,
  openLabel,
  onOpen,
  working = false,
  entries,
  members,
}: {
  direction: keyof typeof GLYPHS;
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  peerName: string;
  text: string;
  openLabel?: string;
  onOpen?: () => void;
  /** The other bot is still at work, so the line shows that instead of the excerpt. */
  working?: boolean;
  entries?: PeerMessageEntry[];
  members?: GroupAvatarMember[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (entries && members) {
    return (
      <PeerGroupCard
        label={label}
        entries={entries}
        members={members}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
    );
  }
  const parts = splitPeerLabel(label, peerName);
  const excerpt = plainTextFromMarkdown(text);
  const Glyph = GLYPHS[direction];
  return (
    <div data-testid="peer-message-card" className="mx-auto w-full max-w-md text-body-sm">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={onOpen ? openLabel : undefined}
        aria-expanded={!onOpen && excerpt ? expanded : undefined}
        disabled={!onOpen && !excerpt}
        onClick={onOpen ?? (() => setExpanded((value) => !value))}
        className={LINE_CLASS}
      >
        <Glyph className="size-3.5 shrink-0" aria-hidden="true" />
        {parts.before ? <span className="shrink-0 whitespace-pre">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          <span
            dir="auto"
            className="max-w-[45%] shrink-0 truncate font-medium"
            style={{ color: resolvePersonaColorDef(identity, color).hex }}
          >
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="shrink-0 whitespace-pre">{parts.after}</span> : null}
        <span dir="auto" className="min-w-0 flex-1 truncate text-foreground/75">
          {working ? (
            <span className="text-shimmer">
              <Trans>Working…</Trans>
            </span>
          ) : expanded ? null : (
            excerpt
          )}
        </span>
        {onOpen ? <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      </button>
      {expanded ? (
        <div dir="auto" className="mt-1 px-2 text-body leading-normal text-foreground/90">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      ) : null}
    </div>
  );
}

const LINE_CLASS =
  "flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-start text-muted-foreground hover:bg-muted disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

function PeerGroupCard({
  label,
  entries,
  members,
  expanded,
  onToggle,
}: {
  label: string;
  entries: PeerMessageEntry[];
  members: GroupAvatarMember[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const latest = entries.at(-1);
  return (
    <div data-testid="peer-message-card" className="mx-auto w-full max-w-md text-body-sm">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-expanded={expanded}
        onClick={onToggle}
        className={LINE_CLASS}
      >
        <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
        <GroupAvatar members={members} size={16} className="shrink-0" />
        <span dir="auto" className="max-w-[45%] shrink-0 truncate font-medium">
          {label}
        </span>
        <span dir="auto" className="min-w-0 flex-1 truncate text-foreground/75">
          {latest && !expanded ? `${latest.peerName}: ${plainTextFromMarkdown(latest.text)}` : null}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <ul className="mt-0.5 flex flex-col">
          {entries.map((entry) => {
            const Glyph = GLYPHS[entry.direction];
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  aria-label={entry.onOpen ? entry.openLabel : undefined}
                  disabled={!entry.onOpen}
                  onClick={entry.onOpen}
                  className={LINE_CLASS}
                >
                  <Glyph className="size-3.5 shrink-0" aria-hidden="true" />
                  <BotAvatar
                    avatarSet={entry.avatarSet}
                    color={entry.color}
                    identity={entry.identity}
                    size={16}
                  />
                  <span
                    dir="auto"
                    className="max-w-[45%] shrink-0 truncate font-medium"
                    style={{ color: resolvePersonaColorDef(entry.identity, entry.color).hex }}
                  >
                    {entry.peerName}
                  </span>
                  <span dir="auto" className="min-w-0 flex-1 truncate text-foreground/75">
                    {plainTextFromMarkdown(entry.text)}
                  </span>
                  {entry.onOpen ? (
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The working bot with what it is doing right now, such as its current tool call. */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-10 min-w-0 items-center gap-2.5 px-1">
      <GroupAvatar members={bots} size={28} />
      <span
        key={label}
        dir="auto"
        className="block min-w-0 truncate text-body-lg text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
      >
        <span className="text-shimmer">{label}</span>
      </span>
    </div>
  );
}
