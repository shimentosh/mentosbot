import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Inbox, InboxEntry } from "@rakazo/contracts";
import { groupRecent } from "@rakazo/core";
import { BotAvatar, Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import { inboxQueryKey } from "../../lib/inbox";
import { queryClient, useQueryUserId } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { rpc, selectedSpaceId } from "../../lib/rpc";

function inboxQuery(userId: string | null, spaceId: string | null) {
  return queryOptions({
    queryKey: [...inboxQueryKey(userId), spaceId ?? ""],
    queryFn: () => rpc.inbox.list(),
  });
}

export function NotificationBell({
  bots,
  onOpenChat,
  onShowActivity,
}: {
  /** The open Space's bots, whose live status shows a request arriving or being answered. */
  bots: ReadonlyArray<{ id: string; status: string }>;
  /** Opens a bot's or group's chat, switching Space when it is in another. */
  onOpenChat: (spaceId: string, path: string) => void;
  onShowActivity: () => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const spaceId = selectedSpaceId();
  const [open, setOpen] = useState(false);
  const { data: inbox, refetch } = useQuery(
    { ...inboxQuery(userId, spaceId), enabled: Boolean(userId) },
    queryClient,
  );
  // Answered here, on another device, or asked by a bot whose alerts are off: the roster sees it.
  const waiting = bots
    .filter((bot) => bot.status === "waiting_input" || bot.status === "waiting_takeover")
    .map((bot) => bot.id)
    .sort()
    .join(",");
  const lastWaiting = useRef(waiting);
  useEffect(() => {
    if (lastWaiting.current === waiting) return;
    lastWaiting.current = waiting;
    if (userId) void refetch();
  }, [waiting, userId, refetch]);
  const needs = inbox?.needsYou.length ?? 0;
  const unread = inbox?.unread ?? 0;
  const label = needs
    ? t`Notifications, ${needs} need you`
    : unread
      ? t`Notifications, new`
      : t`Notifications`;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) void refetch();
    // Dots stay while the list is open, so what was new can still be told apart.
    else if (unread)
      void rpc.inbox
        .markRead()
        .then(() => queryClient.invalidateQueries({ queryKey: inboxQueryKey(userId) }));
  }

  function openEntry(entry: InboxEntry) {
    changeOpen(false);
    onOpenChat(entry.spaceId, entry.groupId ? `/app/g/${entry.groupId}` : `/app/${entry.bot.id}`);
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <IconTooltip label={t`Notifications`}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="app-no-drag relative text-muted-foreground"
            />
          }
          aria-label={label}
          data-testid="notification-bell"
        >
          <Bell size={15} strokeWidth={1.8} aria-hidden="true" />
          {needs ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
            >
              {needs > 9 ? "9+" : needs}
            </span>
          ) : unread ? (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </PopoverTrigger>
      </IconTooltip>
      {open ? (
        <PopoverContent
          align="end"
          className="app-no-drag w-80 gap-0 overflow-hidden p-0"
          data-testid="notification-list"
        >
          <InboxList
            inbox={inbox}
            onOpen={openEntry}
            onShowActivity={() => {
              changeOpen(false);
              onShowActivity();
            }}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

export function InboxList({
  inbox,
  onOpen,
  onShowActivity,
}: {
  inbox: Inbox | undefined;
  onOpen: (entry: InboxEntry) => void;
  onShowActivity: () => void;
}) {
  const needs = inbox?.needsYou ?? [];
  const recent = groupRecent(inbox?.recent ?? []);
  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!inbox ? null : needs.length === 0 && recent.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            <Trans>You're all caught up</Trans>
          </p>
        ) : (
          <>
            {needs.length ? (
              <Section title={<Trans>Needs you</Trans>}>
                {needs.map((entry) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    count={1}
                    highlight
                    showSpace={entry.spaceId !== inbox?.spaceId}
                    onOpen={onOpen}
                  />
                ))}
              </Section>
            ) : null}
            {recent.length ? (
              <Section title={<Trans>Recent</Trans>}>
                {recent.map(({ entry, count, read }) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    count={count}
                    highlight={!read}
                    showSpace={entry.spaceId !== inbox?.spaceId}
                    onOpen={onOpen}
                  />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onShowActivity}
        className="border-t border-border px-4 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Trans>All activity</Trans>
      </button>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="px-4 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function Row({
  entry,
  count,
  highlight,
  showSpace,
  onOpen,
}: {
  entry: InboxEntry;
  count: number;
  highlight: boolean;
  showSpace: boolean;
  onOpen: (entry: InboxEntry) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent"
      >
        <BotAvatar
          identity={entry.bot.id}
          color={entry.bot.color}
          avatarSet={entry.bot.avatarSet}
          size={24}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground">
              {entry.bot.name}
            </span>
            {showSpace ? (
              <span className="truncate text-[12px] text-muted-foreground">{entry.spaceName}</span>
            ) : null}
          </span>
          <span className="block truncate text-[12.5px] text-muted-foreground">
            <KindText kind={entry.kind} count={count} />
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {formatRelativeTime(entry.at)}
          {highlight ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
          ) : null}
        </span>
      </button>
    </li>
  );
}

function KindText({ kind, count }: { kind: InboxEntry["kind"]; count: number }) {
  switch (kind) {
    case "approval":
      return <Trans>Needs your approval</Trans>;
    case "answer":
      return <Trans>Has a question</Trans>;
    case "takeover":
      return <Trans>Needs you on the screen</Trans>;
    case "failure":
      return count === 1 ? (
        <Trans>Failed</Trans>
      ) : (
        <Plural value={count} one="Failed # time" other="Failed # times" />
      );
    default:
      return count === 1 ? (
        <Trans>Finished</Trans>
      ) : (
        <Plural value={count} one="Finished # task" other="Finished # tasks" />
      );
  }
}
