import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { BotAvatarSet } from "@rakazo/contracts";
import { plainTextFromMarkdown, splitPeerLabel } from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, Button, GroupAvatar, resolvePersonaColorDef } from "@rakazo/ui-web";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
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
 * What one bot sent another: who, a one-line excerpt that expands in place, and an Open that
 * leads to the whole exchange when the viewer can see it. Given `entries` from several bots,
 * the line names them all and expands to one row per message, each with its own Open.
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
    <div
      data-testid="peer-message-card"
      className="mx-auto w-full max-w-md rounded-xl border border-border px-3 py-2 text-body-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-testid="peer-receipt-chip"
          aria-expanded={excerpt ? expanded : undefined}
          disabled={!excerpt}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-start text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          <span className="flex min-w-0 max-w-full items-center gap-1">
            <Glyph className="size-3.5 shrink-0" aria-hidden="true" />
            {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
            <span className="shrink-0">
              <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
            </span>
            {parts.name ? (
              <span
                dir="auto"
                className="truncate font-medium"
                style={{ color: resolvePersonaColorDef(identity, color).hex }}
              >
                {parts.name}
              </span>
            ) : null}
            {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
          </span>
          {excerpt && !expanded ? (
            <span dir="auto" className="w-full truncate text-foreground/75">
              {excerpt}
            </span>
          ) : null}
        </button>
        {onOpen ? (
          <Button
            variant="text"
            size="xs"
            aria-label={openLabel}
            onClick={onOpen}
            className="shrink-0 font-normal"
          >
            <Trans>Open</Trans>
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div dir="auto" className="mt-1.5 text-body leading-normal text-foreground/90">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      ) : null}
    </div>
  );
}

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
  const excerpt = latest ? plainTextFromMarkdown(latest.text) : "";
  return (
    <div
      data-testid="peer-message-card"
      className="mx-auto w-full max-w-md rounded-xl border border-border px-3 py-2 text-body-sm"
    >
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md text-start text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
          <GroupAvatar members={members} size={16} className="shrink-0" />
          <span dir="auto" className="truncate">
            {label}
          </span>
        </span>
        {excerpt && !expanded ? (
          <span dir="auto" className="w-full truncate text-foreground/75">
            {latest ? `${latest.peerName}: ${excerpt}` : excerpt}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {entries.map((entry) => {
            const Glyph = GLYPHS[entry.direction];
            return (
              <li key={entry.key} className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
                    <Glyph className="size-3.5 shrink-0" aria-hidden="true" />
                    <BotAvatar
                      avatarSet={entry.avatarSet}
                      color={entry.color}
                      identity={entry.identity}
                      size={16}
                    />
                    <span
                      dir="auto"
                      className="truncate font-medium"
                      style={{ color: resolvePersonaColorDef(entry.identity, entry.color).hex }}
                    >
                      {entry.peerName}
                    </span>
                  </div>
                  <p dir="auto" className="line-clamp-2 text-foreground/75">
                    {plainTextFromMarkdown(entry.text)}
                  </p>
                </div>
                {entry.onOpen ? (
                  <Button
                    variant="text"
                    size="xs"
                    aria-label={entry.openLabel}
                    onClick={entry.onOpen}
                    className="shrink-0 font-normal"
                  >
                    <Trans>Open</Trans>
                    <ChevronRight data-icon="inline-end" aria-hidden="true" />
                  </Button>
                ) : null}
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
