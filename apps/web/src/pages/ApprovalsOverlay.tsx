import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Approval, Bot, Group, LoginFieldInput } from "@rakazo/contracts";
import { isApprovalAskBlock, isRetryableError } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BotAvatar,
  Button,
  buttonVariants,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CheckCheck, ExternalLink, SlidersHorizontal, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { AskCard } from "../components/AskCard";
import type { ActivityListFilters } from "../lib/activity-list-filters";
import { emptyActivityFilters } from "../lib/activity-list-filters";
import { approvalsQueryKey, inboxQueryKey } from "../lib/inbox";
import { queryClient, useQueryUserId } from "../lib/query";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc, rpcForSpace, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ActivityList } from "./ActivityList";
import { ArtifactImage } from "./shell/message-cards";

/** How long an answered card stays to show its outcome before the list drops it. */
const ANSWERED_LINGER_MS = 900;

function chatPath(approval: Approval): string {
  return approval.groupId ? `/app/g/${approval.groupId}` : `/app/${approval.bot.id}`;
}

function answerApproval(
  approval: Approval,
  messageId: string,
  answer: string,
  fields?: LoginFieldInput[],
  remember?: false,
  dismiss?: boolean,
) {
  return rpcForSpace(approval.spaceId).threads.answer({
    ...(approval.groupId ? { groupId: approval.groupId } : { botId: approval.bot.id }),
    runId: approval.runId,
    messageId,
    answer,
    ...(fields ? { fields } : {}),
    ...(remember === false ? { remember } : {}),
    ...(dismiss ? { dismiss: true as const } : {}),
  });
}

/** Cards whose approve answer is plain, so "Approve all" can send it for the person. */
function approvable(approval: Approval): boolean {
  return Boolean(approval.ask && isApprovalAskBlock(approval.ask.block));
}

/** Everything waiting on the person beside what their bots are doing, answered in one place. */
export function ApprovalsOverlay({
  bots,
  groups,
  onClose,
  onOpenChat,
}: {
  /** The open Space's bots and groups, for the activity list. */
  bots: Bot[];
  groups: Group[];
  onClose: () => void;
  /** Opens a bot's or group's chat; `null` is the open Space, another switches to it. */
  onOpenChat: (spaceId: string | null, path: string) => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const spaceId = selectedSpaceId();
  const approvalsQuery = useQuery(
    {
      queryKey: [...approvalsQueryKey(userId), spaceId ?? ""],
      queryFn: () => rpc.inbox.approvals(),
      enabled: Boolean(userId),
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : 10_000,
    },
    queryClient,
  );
  const [botFilter, setBotFilter] = useState("all");
  const [confirmAll, setConfirmAll] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ActivityListFilters>(emptyActivityFilters);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [toggledSections, setToggledSections] = useState<ReadonlySet<string>>(new Set());
  const filtersId = useId();
  const trackedBots = bots.filter((bot) => bot.trackerUrl);
  const [view, setView] = useState<"approvals" | "trackers">("approvals");

  const approvals = approvalsQuery.data ?? [];
  const askers = useMemo(() => {
    const seen = new Map<string, Approval["bot"]>();
    for (const approval of approvals) seen.set(approval.bot.id, approval.bot);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [approvals]);
  const shown =
    botFilter === "all" ? approvals : approvals.filter((item) => item.bot.id === botFilter);
  const bulk = shown.filter(approvable);
  const filterCount =
    Number(filters.status !== "all") +
    Number(Boolean(filters.dateRange.from)) +
    Number(Boolean(filters.dateRange.to));

  const refresh = () => queryClient.invalidateQueries({ queryKey: inboxQueryKey(userId) });
  const refreshSoon = () => window.setTimeout(() => void refresh(), ANSWERED_LINGER_MS);
  const openChat = (approval: Approval) => onOpenChat(approval.spaceId, chatPath(approval));

  async function approveAll() {
    setApprovingAll(true);
    setAllError(null);
    const results = await Promise.allSettled(
      bulk.map((approval) => answerApproval(approval, approval.ask!.messageId, "allow")),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    setApprovingAll(false);
    setConfirmAll(false);
    if (failed) setAllError(t`Could not approve ${failed} of ${results.length}.`);
    await refresh();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="approvals"
        className="flex h-[820px] max-h-[calc(100%-2rem)] w-[1120px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1120px]"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b border-border px-6 py-4">
          {trackedBots.length ? (
            <>
              <DialogTitle className="sr-only">
                <Trans>Approvals</Trans>
              </DialogTitle>
              <div className="flex-1">
                <Tabs
                  value={view}
                  onValueChange={(next) => setView(next as "approvals" | "trackers")}
                >
                  <TabsList aria-label={t`View`}>
                    <TabsTrigger value="approvals" className="px-3">
                      <Trans>Approvals</Trans>
                    </TabsTrigger>
                    <TabsTrigger value="trackers" className="px-3">
                      <Trans>Trackers</Trans>
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </>
          ) : (
            <DialogTitle className="flex-1 text-heading2 text-foreground">
              <Trans>Approvals</Trans>
            </DialogTitle>
          )}
          {view === "approvals" && askers.length > 1 ? (
            <div className="w-44">
              <NativeSelect
                size="sm"
                aria-label={t`Bot`}
                value={botFilter}
                onChange={(event) => setBotFilter(event.target.value)}
              >
                <NativeSelectOption value="all">{t`All bots`}</NativeSelectOption>
                {askers.map((bot) => (
                  <NativeSelectOption key={bot.id} value={bot.id}>
                    {bot.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {view === "approvals" && bulk.length > 1 ? (
            <Button size="sm" onClick={() => setConfirmAll(true)}>
              <CheckCheck aria-hidden="true" />
              <Trans>Approve all</Trans>
            </Button>
          ) : null}
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close approvals`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

        {view === "trackers" ? (
          <Trackers bots={trackedBots} />
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
            <section
              aria-labelledby={`${filtersId}-waiting`}
              className="min-w-0 px-6 py-5 md:overflow-y-auto"
            >
              <SectionHeading
                as="h2"
                id={`${filtersId}-waiting`}
                className="mb-4 flex items-center gap-2"
              >
                <Trans>Waiting for you</Trans>
                {shown.length ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[12px] tabular-nums text-muted-foreground">
                    {shown.length}
                  </span>
                ) : null}
              </SectionHeading>
              {allError ? (
                <p role="alert" className="mb-4 text-[13px] text-destructive">
                  {allError}
                </p>
              ) : null}
              {approvalsQuery.isPending ? (
                <Spinner aria-label={t`Loading approvals…`} />
              ) : approvalsQuery.error && !approvalsQuery.data ? (
                <div role="alert" className="text-[13px] text-destructive">
                  {errorText(approvalsQuery.error)}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ms-3"
                    onClick={() => void approvalsQuery.refetch()}
                  >
                    <Trans>Try again</Trans>
                  </Button>
                </div>
              ) : shown.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-20 text-center">
                  <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <CheckCheck size={22} aria-hidden="true" />
                  </span>
                  <p className="text-[15px] font-medium text-foreground">
                    <Trans>All caught up</Trans>
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-6">
                  {shown.map((approval) => (
                    <ApprovalItem
                      key={approval.runId}
                      approval={approval}
                      showSpace={approval.spaceId !== spaceId}
                      onAnswered={refreshSoon}
                      onOpen={() => openChat(approval)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <aside
              aria-labelledby={`${filtersId}-activity`}
              className="min-w-0 border-t border-border bg-sidebar px-3 py-5 md:overflow-y-auto md:border-s md:border-t-0"
            >
              <div className="mb-3 flex items-center gap-2 px-2.5">
                <SectionHeading as="h2" id={`${filtersId}-activity`} className="flex-1">
                  <Trans>Activity</Trans>
                </SectionHeading>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Filters`}
                  aria-expanded={filtersExpanded}
                  aria-controls={filtersId}
                  onClick={() => setFiltersExpanded((expanded) => !expanded)}
                  className="relative text-muted-foreground"
                >
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  {filterCount > 0 ? (
                    <span
                      data-testid="activity-filter-indicator"
                      aria-hidden="true"
                      className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </Button>
              </div>
              <div className="mb-2 px-2.5">
                <ListSearchInput
                  query={filters.query}
                  setQuery={(query) => setFilters({ ...filters, query })}
                  label={t`Search runs`}
                  placeholder={t`Search runs`}
                />
              </div>
              <ActivityList
                bots={bots}
                groups={groups}
                toggledSections={toggledSections}
                onToggleSection={(key) =>
                  setToggledSections((current) => {
                    const next = new Set(current);
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })
                }
                onOpenRun={(run) =>
                  onOpenChat(null, run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`)
                }
                onOpenBot={(bot) => onOpenChat(null, `/app/${bot.id}`)}
                onOpenGroup={(group) => onOpenChat(null, `/app/g/${group.id}`)}
                filters={filters}
                onFiltersChange={setFilters}
                filtersExpanded={filtersExpanded}
                filtersId={filtersId}
              />
            </aside>
          </div>
        )}

        {confirmAll ? (
          <AlertDialog
            open
            onOpenChange={(open) => {
              if (!open && !approvingAll) setConfirmAll(false);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Plural
                    value={bulk.length}
                    one="Approve # request?"
                    other="Approve # requests?"
                  />
                </AlertDialogTitle>
              </AlertDialogHeader>
              <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto text-[13.5px]">
                {bulk.map((approval) => (
                  <li key={approval.runId} className="flex min-w-0 items-center gap-2">
                    <BotAvatar
                      identity={approval.bot.id}
                      color={approval.bot.color}
                      avatarSet={approval.bot.avatarSet}
                      size={20}
                    />
                    <span className="shrink-0 font-medium text-foreground">
                      {approval.bot.name}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {approval.ask?.block.kind === "ask" ? approval.ask.block.text : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={approvingAll}>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction disabled={approvingAll} onClick={() => void approveAll()}>
                  {approvingAll ? <Trans>Approving…</Trans> : <Trans>Approve all</Trans>}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ApprovalItem({
  approval,
  showSpace,
  onAnswered,
  onOpen,
}: {
  approval: Approval;
  showSpace: boolean;
  onAnswered: () => void;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const { ask, bot } = approval;
  const target = approval.groupId ? { groupId: approval.groupId } : { botId: bot.id };
  return (
    <li className="flex min-w-0 gap-3" data-testid="approval">
      <BotAvatar identity={bot.id} color={bot.color} avatarSet={bot.avatarSet} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-medium text-foreground">{bot.name}</span>
          <span className="shrink-0 text-[12.5px] text-muted-foreground">
            {showSpace
              ? `${approval.spaceName} · ${formatRelativeTime(approval.at)}`
              : formatRelativeTime(approval.at)}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ms-auto shrink-0 text-muted-foreground"
            onClick={onOpen}
          >
            <Trans>Open chat</Trans>
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
        {ask?.block.kind === "ask" ? (
          <AskCard
            block={ask.block}
            canAnswer
            canDismiss
            rpc={rpcForSpace(approval.spaceId)}
            onAnswer={async (text, fields, remember) => {
              await answerApproval(approval, ask.messageId, text, fields, remember);
              onAnswered();
            }}
            onDismiss={async () => {
              await answerApproval(approval, ask.messageId, "", undefined, undefined, true);
              onAnswered();
            }}
            renderImage={
              showSpace
                ? undefined
                : (image) => (
                    <ArtifactImage
                      target={target}
                      artifactId={image.artifactId}
                      name={image.name}
                    />
                  )
            }
          />
        ) : (
          <div className="flex items-center gap-3 rounded-[20px] bg-muted px-5 py-4 text-[14px] text-foreground">
            <span className="flex-1">{t`Needs you in the chat`}</span>
            <Button size="sm" onClick={onOpen}>
              <Trans>Open</Trans>
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Each bot's tracker page, one at a time, in a sandboxed frame. */
function Trackers({ bots }: { bots: Bot[] }) {
  const { t } = useLingui();
  const [selectedId, setSelectedId] = useState(bots[0]?.id);
  const selected = bots.find((bot) => bot.id === selectedId) ?? bots[0];
  if (!selected?.trackerUrl) return null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
      <nav
        aria-label={t`Trackers`}
        className="flex gap-1 overflow-x-auto border-b border-border bg-sidebar p-3 md:flex-col md:overflow-y-auto md:border-e md:border-b-0"
      >
        {bots.map((bot) => (
          <button
            key={bot.id}
            type="button"
            aria-current={bot.id === selected.id ? "page" : undefined}
            onClick={() => setSelectedId(bot.id)}
            className="flex shrink-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            <BotAvatar identity={bot.id} color={bot.color} avatarSet={bot.avatarSet} size={24} />
            <span className="truncate">{bot.name}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {selected.trackerUrl}
          </span>
          <a
            href={selected.trackerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "ghost", size: "xs" })}
          >
            <Trans>Open</Trans>
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
        <iframe
          key={selected.id}
          src={selected.trackerUrl}
          title={t`${selected.name} tracker`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerPolicy="no-referrer"
          className="min-h-[420px] w-full flex-1 border-0 bg-background"
        />
      </div>
    </div>
  );
}
