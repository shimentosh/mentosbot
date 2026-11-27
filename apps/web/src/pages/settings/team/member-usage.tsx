import { Trans, useLingui } from "@lingui/react/macro";
import type { TeamUsagePeriod, TeamUsageRow } from "@rakazo/contracts";
import { OptionSelect } from "@rakazo/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient, useQueryUserId } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";

export function teamUsageQuery(
  userId: string | null,
  organizationId: string,
  period: TeamUsagePeriod,
) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "team-usage", organizationId, period],
    queryFn: () => rpc.team.usage({ organizationId, period }),
  });
}

/** Sums one person's rows, across every bot or within one. */
export function totalUsage(rows: readonly TeamUsageRow[]) {
  return rows.reduce(
    (sum, row) => ({
      costUsd: sum.costUsd + row.costUsd,
      totalTokens: sum.totalTokens + row.totalTokens,
      calls: sum.calls + row.calls,
    }),
    { costUsd: 0, totalTokens: 0, calls: 0 },
  );
}

export function useUsageFormat() {
  const { i18n } = useLingui();
  const count = new Intl.NumberFormat(i18n.locale, { notation: "compact" });
  const usd = new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" });
  return {
    tokens: (value: number) => count.format(value),
    cost: (value: number) =>
      value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value),
  };
}

/** How much a teammate has used, in total and by bot, under their dialog's Usage tab. */
export function MemberUsage({
  organizationId,
  memberUserId,
}: {
  organizationId: string;
  memberUserId: string;
}) {
  const { t, i18n } = useLingui();
  const userId = useQueryUserId();
  const [period, setPeriod] = useState<TeamUsagePeriod>("30d");
  const { data } = useQuery(
    {
      ...teamUsageQuery(userId, organizationId, period),
      enabled: Boolean(userId),
      placeholderData: keepPreviousData,
    },
    queryClient,
  );
  const format = useUsageFormat();
  if (!data) return null;
  const rows = data.filter((row) => row.userId === memberUserId);
  const total = totalUsage(rows);
  const last = rows.reduce<string | null>(
    (latest, row) => (latest && latest > row.lastUsedAt ? latest : row.lastUsedAt),
    null,
  );
  return (
    <section className="space-y-3" data-testid="member-usage">
      <div className="flex justify-end">
        <OptionSelect<TeamUsagePeriod>
          aria-label={t`Usage period`}
          size="sm"
          className="w-40"
          value={period}
          onValueChange={setPeriod}
          options={[
            { value: "30d", label: t`Last 30 days` },
            { value: "all", label: t`All time` },
          ]}
        />
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {[
          { label: t`Cost`, value: format.cost(total.costUsd) },
          { label: t`Tokens`, value: format.tokens(total.totalTokens) },
          {
            label: t`Last used`,
            value: last ? i18n.date(last, { dateStyle: "medium" }) : t`Never`,
          },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border px-3 py-2">
            <dt className="text-body-sm text-muted-foreground">{stat.label}</dt>
            <dd className="mt-0.5 truncate text-body font-medium tabular-nums text-foreground">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
      {rows.length ? (
        <Table className="text-body">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-muted-foreground">
                <Trans>Bot</Trans>
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                <Trans>Tokens</Trans>
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                <Trans>Cost</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.botId ?? "none"} className="hover:bg-transparent">
                <TableCell className="max-w-0 truncate">{row.botName ?? t`Other`}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.tokens(row.totalTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.cost(row.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}
