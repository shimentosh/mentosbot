import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAccessLevel, Team } from "@rakazo/contracts";
import { Spinner, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient, useQueryUserId, useSave } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { BotAccessList } from "./bot-access-list";
import { MemberUsage } from "./member-usage";
import { RoleName } from "./role-name";

export function grantableBotsQuery(
  userId: string | null,
  organizationId: string,
  memberUserId?: string,
) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "grantable-bots", organizationId, memberUserId ?? ""],
    queryFn: () => rpc.team.grantableBots({ organizationId, userId: memberUserId }),
  });
}

type Change = { botId: string; level: BotAccessLevel | null };

/** One teammate: which bots they may use, and for the team's owner, how much they have used. */
export function MemberPage({
  organizationId,
  member,
  showUsage,
}: {
  organizationId: string;
  member: Team["members"][number];
  /** Usage is the team owner's alone. */
  showUsage: boolean;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const [tab, setTab] = useState<"bots" | "usage">("bots");
  const query = grantableBotsQuery(userId, organizationId, member.userId);
  const { data: bots, error } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const save = useSave({
    save: async (changes: Change[], client) => {
      // Each bot saves on its own; the list re-reads afterwards, so a partial failure shows as is.
      const results = await Promise.allSettled(
        changes.map((change) =>
          change.level
            ? client.team.shareBot({
                botId: change.botId,
                userId: member.userId,
                level: change.level,
              })
            : client.team.unshareBot({ botId: change.botId, userId: member.userId }),
        ),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    stale: [query.queryKey],
  });
  const shown = member.name.trim() || member.email;
  const levelOf = (botId: string) => {
    const pending = save.pending ? save.input?.find((change) => change.botId === botId) : undefined;
    return pending ? pending.level : (bots?.find((bot) => bot.id === botId)?.level ?? null);
  };
  return (
    <div className="flex flex-col gap-6" data-testid="team-member">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="break-words text-heading3 text-foreground">{shown}</h3>
          <p className="truncate text-body-sm text-muted-foreground">
            {shown !== member.email ? `${member.email} · ` : null}
            <RoleName role={member.role} />
          </p>
        </div>
        {showUsage ? (
          <Tabs value={tab} onValueChange={(next) => setTab(next as "bots" | "usage")}>
            <TabsList aria-label={t`View`}>
              <TabsTrigger value="bots" className="px-3">
                <Trans>Bots</Trans>
              </TabsTrigger>
              <TabsTrigger value="usage" className="px-3">
                <Trans>Usage</Trans>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>
      {tab === "usage" && showUsage ? (
        <MemberUsage organizationId={organizationId} memberUserId={member.userId} />
      ) : error && !bots ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(error)}
        </p>
      ) : !bots ? (
        <Spinner aria-label={t`Loading bots…`} />
      ) : bots.length === 0 ? (
        <p className="py-6 text-center text-body-sm text-muted-foreground">
          <Trans>You have no bots to share yet.</Trans>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <BotAccessList
            bots={bots}
            levelOf={levelOf}
            personName={shown}
            disabled={save.pending}
            onChange={(changes) => {
              if (changes.length) save.run(changes);
            }}
          />
          {save.error ? (
            <p role="alert" className="text-body-sm text-destructive">
              {errorText(save.error)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
