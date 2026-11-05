import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotAccessEntry, BotAccessLevel } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useOrganizations } from "../../lib/organizations";
import { queryClient, useQueryUserId } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const display = (person: { name: string; email: string }) => person.name.trim() || person.email;

/**
 * Who else can use this bot. It keeps running as its owner, with the owner's apps and memory, so
 * the list is short and each person's access is explicit.
 */
export function BotShareSection({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((each) => each.id === activeOrganizationId);
  const canShare = !bot.share || bot.share.level === "manage";
  const enabled = Boolean(userId && organization && organization.memberCount > 1 && canShare);
  const accessKey = [`user:${userId ?? ""}`, "bot-access", bot.id];
  const { data: access = [] } = useQuery(
    {
      queryKey: accessKey,
      queryFn: () => rpc.team.botAccess({ botId: bot.id }),
      enabled,
    },
    queryClient,
  );
  const { data: team } = useQuery(
    {
      queryKey: [`user:${userId ?? ""}`, "team", activeOrganizationId ?? ""],
      queryFn: () => rpc.team.get({ organizationId: activeOrganizationId! }),
      enabled,
    },
    queryClient,
  );
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;

  const set = (next: BotAccessEntry[]) => queryClient.setQueryData(accessKey, next);
  async function share(memberUserId: string, level: BotAccessLevel) {
    setError(null);
    try {
      set(await rpc.team.shareBot({ botId: bot.id, userId: memberUserId, level }));
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  async function unshare(memberUserId: string) {
    setError(null);
    try {
      await rpc.team.unshareBot({ botId: bot.id, userId: memberUserId });
      set(access.filter((entry) => entry.userId !== memberUserId));
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  const sharedIds = new Set(access.map((entry) => entry.userId));
  const candidates = (team?.members ?? []).filter(
    (member) =>
      member.userId !== userId &&
      member.userId !== bot.share?.ownerUserId &&
      !sharedIds.has(member.userId),
  );

  return (
    <section className="mt-6" data-testid="bot-share">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionHeading variant="label">
          <Trans>Shared with</Trans>
        </SectionHeading>
        {candidates.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
              <UserPlus aria-hidden="true" />
              <Trans>Share</Trans>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {candidates.map((member) => (
                <DropdownMenuItem
                  key={member.userId}
                  onClick={() => void share(member.userId, "chat")}
                >
                  {display(member)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {access.length ? (
        <ul className="divide-y divide-border rounded-xl bg-muted/50">
          {access.map((entry) => (
            <li key={entry.userId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{display(entry)}</span>
              <NativeSelect
                aria-label={t`Access for ${display(entry)}`}
                value={entry.level}
                onChange={(event) => void share(entry.userId, event.target.value as BotAccessLevel)}
              >
                <NativeSelectOption value="chat">{t`Can chat`}</NativeSelectOption>
                <NativeSelectOption value="manage">{t`Can manage`}</NativeSelectOption>
              </NativeSelect>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Stop sharing with ${display(entry)}`}
                onClick={() => void unshare(entry.userId)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {access.length && !bot.share ? (
        <p className="mt-2 px-1 text-[12.5px] text-muted-foreground">
          <Trans>They use it with your apps, memory and saved sign-ins.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 px-1 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
