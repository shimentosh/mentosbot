import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { TeamBot, ThreadMessage } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Spinner,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, Paperclip, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useOrganizations } from "../../lib/organizations";
import { queryClient, useQueryUserId } from "../../lib/query";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { TRANSCRIPT_CONTENT_PADDING } from "../../lib/transcript-layout";

/** The members a filter can pick, in the order their bots appear. */
export function teamMembers(bots: readonly TeamBot[]) {
  const seen = new Map<string, TeamBot["owner"]>();
  for (const bot of bots) if (!seen.has(bot.owner.userId)) seen.set(bot.owner.userId, bot.owner);
  return [...seen.values()];
}

const personName = (owner: TeamBot["owner"]) => owner.name.trim() || owner.email;

/**
 * For a team's owner: every teammate's bot in this Space, filterable by member. Each opens its
 * chat to read; nothing here acts as the teammate.
 */
export function TeamBotsSection() {
  const userId = useQueryUserId();
  const spaceId = selectedSpaceId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((each) => each.id === activeOrganizationId);
  const overseeing = organization?.role === "owner" && organization.memberCount > 1;
  const { data: bots = [] } = useQuery(
    {
      queryKey: [`user:${userId ?? ""}`, "team-bots", spaceId ?? ""],
      queryFn: () => rpc.team.bots(),
      enabled: Boolean(userId) && overseeing,
    },
    queryClient,
  );
  const [member, setMember] = useState<string>("all");
  const [open, setOpen] = useState<TeamBot | null>(null);
  const members = useMemo(() => teamMembers(bots), [bots]);
  if (!overseeing || bots.length === 0) return null;
  const shown = bots.filter(
    (bot) => !bot.archived && (member === "all" || bot.owner.userId === member),
  );
  return (
    <section className="px-3 pt-3" data-testid="team-bots">
      <TeamBotsHeader members={members} member={member} onMember={setMember} />
      <ul className="mt-1 space-y-0.5">
        {shown.map((bot) => (
          <li key={bot.id}>
            <button
              type="button"
              onClick={() => setOpen(bot)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
            >
              <BotAvatar
                identity={bot.id}
                color={bot.color}
                avatarSet={bot.avatarSet}
                status={bot.status}
                size={22}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">{bot.name}</span>
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  {personName(bot.owner)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open ? <TeamBotChat bot={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function TeamBotsHeader({
  members,
  member,
  onMember,
}: {
  members: TeamBot["owner"][];
  member: string;
  onMember: (member: string) => void;
}) {
  const { t } = useLingui();
  const chosen = members.find((each) => each.userId === member);
  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <h3 className="text-[11.5px] font-medium tracking-wide text-muted-foreground uppercase">
        <Trans>Team</Trans>
      </h3>
      {members.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="max-w-36 text-muted-foreground"
                aria-label={t`Show bots of`}
              />
            }
          >
            <span className="truncate">{chosen ? personName(chosen) : t`Everyone`}</span>
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuRadioGroup
              value={member}
              onValueChange={(value) => onMember(String(value))}
            >
              <DropdownMenuRadioItem value="all">
                <Trans>Everyone</Trans>
              </DropdownMenuRadioItem>
              {members.map((each) => (
                <DropdownMenuRadioItem key={each.userId} value={each.userId}>
                  {personName(each)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** A teammate's bot's chat to read, newest at the bottom, older pages on request. */
function TeamBotChat({ bot, onClose }: { bot: TeamBot; onClose: () => void }) {
  const { t } = useLingui();
  const pages = useInfiniteQuery(
    {
      queryKey: ["team-bot-messages", bot.id],
      queryFn: ({ pageParam }) => rpc.team.botMessages({ botId: bot.id, before: pageParam }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (page) => page.olderCursor ?? undefined,
    },
    queryClient,
  );
  const messages = useMemo(
    () => [...(pages.data?.pages ?? [])].reverse().flatMap((page) => page.messages),
    [pages.data],
  );
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        data-testid="team-bot-chat"
        showCloseButton={false}
        className="flex h-[min(44rem,90vh)] w-[min(44rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <BotAvatar identity={bot.id} color={bot.color} avatarSet={bot.avatarSet} size={24} />
          <DialogTitle className="min-w-0 flex-1 truncate text-[14px] font-medium">
            {bot.name}
            <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">
              {personName(bot.owner)}
            </span>
          </DialogTitle>
          <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="icon-sm" />}>
            <XIcon />
          </DialogClose>
        </div>
        <div
          className={`rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto py-4 ${TRANSCRIPT_CONTENT_PADDING}`}
        >
          {pages.isPending ? (
            <div className="grid flex-1 place-items-center">
              <Spinner aria-label={t`Loading…`} />
            </div>
          ) : pages.isError ? (
            <p role="alert" className="m-auto text-[13px] text-destructive">
              <Trans>Could not load this chat.</Trans>
            </p>
          ) : messages.length === 0 ? (
            <p className="m-auto text-[13px] text-muted-foreground">
              <Trans>No messages yet.</Trans>
            </p>
          ) : (
            <>
              {pages.hasNextPage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-center text-muted-foreground"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  <Trans>Show earlier</Trans>
                </Button>
              ) : null}
              {messages.map((message) => (
                <ReadOnlyMessage key={message.id} message={message} bot={bot} />
              ))}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyMessage({ message, bot }: { message: ThreadMessage; bot: TeamBot }) {
  const fromPerson = message.role === "user";
  const parts = message.blocks.flatMap((block, index) => {
    if (block.kind === "text" || block.kind === "ask")
      return block.text.trim() ? [<ChatMarkdown key={index}>{block.text}</ChatMarkdown>] : [];
    if (block.kind === "file" || block.kind === "image")
      return [
        <span
          key={index}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-background px-2 py-1 text-[12.5px] text-muted-foreground"
        >
          <Paperclip size={12} aria-hidden="true" />
          {block.name}
        </span>,
      ];
    return [];
  });
  if (message.role === "system" || parts.length === 0) return null;
  return (
    <div className={`flex ${fromPerson ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${fromPerson ? "bg-accent" : "bg-muted"}`}
      >
        <div className="mb-1 text-[12px] font-medium text-muted-foreground" dir="auto">
          {fromPerson ? personName(bot.owner) : bot.name}
        </div>
        <div className="text-[14px] leading-[1.5] text-foreground/90" dir="auto">
          {parts}
        </div>
      </div>
    </div>
  );
}
