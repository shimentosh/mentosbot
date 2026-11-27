import { Trans } from "@lingui/react/macro";
import type { BotAccessLevel, Team } from "@rakazo/contracts";
import { Dialog, DialogContent, DialogHeader, DialogTitle, SectionHeading } from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { queryClient, useQueryUserId, useSave } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { BotAccessList } from "./bot-access-list";
import { MemberUsage } from "./member-usage";

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

/** One teammate: which bots they may use, and how much they have used. */
export function MemberDialog({
  organizationId,
  member,
  showUsage,
  onClose,
}: {
  organizationId: string;
  member: Team["members"][number];
  /** Usage is the team owner's alone. */
  showUsage: boolean;
  onClose: () => void;
}) {
  const userId = useQueryUserId();
  const query = grantableBotsQuery(userId, organizationId, member.userId);
  const { data: bots } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const save = useSave({
    save: async (change: { botId: string; level: BotAccessLevel | null }, client) => {
      if (change.level)
        await client.team.shareBot({
          botId: change.botId,
          userId: member.userId,
          level: change.level,
        });
      else await client.team.unshareBot({ botId: change.botId, userId: member.userId });
    },
    stale: [query.queryKey],
  });
  const shown = member.name.trim() || member.email;
  const levelOf = (botId: string) =>
    save.pending && save.input?.botId === botId
      ? save.input.level
      : (bots?.find((bot) => bot.id === botId)?.level ?? null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md" data-testid="member-dialog">
        <DialogHeader>
          <DialogTitle className="break-words">{shown}</DialogTitle>
          {shown !== member.email ? (
            <p className="truncate text-body-sm text-muted-foreground">{member.email}</p>
          ) : null}
        </DialogHeader>
        <div className="space-y-5">
          {bots?.length ? (
            <section className="space-y-2">
              <SectionHeading variant="label">
                <Trans>Bots</Trans>
              </SectionHeading>
              <BotAccessList
                bots={bots}
                levelOf={levelOf}
                personName={shown}
                disabled={save.pending}
                onChange={(botId, level) => save.run({ botId, level })}
              />
              {save.error ? (
                <p role="alert" className="text-body-sm text-destructive">
                  {errorText(save.error)}
                </p>
              ) : null}
            </section>
          ) : null}
          {showUsage ? (
            <MemberUsage organizationId={organizationId} memberUserId={member.userId} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
