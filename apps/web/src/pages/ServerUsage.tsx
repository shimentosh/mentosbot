import { Plural, Trans } from "@lingui/react/macro";
import type { ComputerServerUsage } from "@rakazo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { formatSize } from "../lib/file-size";
import { queryClient, useQueryUserId } from "../lib/query";
import { rpc } from "../lib/rpc";

/** Past this share of memory, disk or CPU a server has little room for another computer. */
const NEARLY_FULL = 0.85;

function serverUsageQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "computer-server-usage"],
    queryFn: () => rpc.computerServers.usage(),
  });
}

/** How busy each server is, so a deployment admin can tell when bots need another one. */
export function ServerUsage() {
  const userId = useQueryUserId();
  const { data } = useQuery(
    { ...serverUsageQuery(userId), enabled: Boolean(userId), refetchInterval: 30_000 },
    queryClient,
  );
  if (!data?.length) return null;
  return (
    <SettingsGroup title={<Trans>Usage</Trans>} data-testid="server-usage">
      {data.map((server) => (
        <SettingsRow
          key={server.id ?? "this-server"}
          label={server.id ? server.name : <Trans>This server</Trans>}
        >
          <ServerUsageDetail server={server} />
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function ServerUsageDetail({ server }: { server: ComputerServerUsage }) {
  const usage = server.usage;
  if (!usage)
    return (
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        <Trans>Not answering</Trans>
      </p>
    );
  const memoryUsed = usage.memory.total - usage.memory.available;
  const diskUsed = usage.disk ? usage.disk.total - usage.disk.available : 0;
  const shares = [
    memoryUsed / usage.memory.total,
    usage.disk ? diskUsed / usage.disk.total : 0,
    usage.load / Math.max(1, usage.cpus),
  ];
  const running = usage.computers.filter((computer) => computer.running);
  return (
    <div className="mt-2 space-y-2.5">
      <Meter
        label={<Trans>CPU</Trans>}
        share={shares[2]!}
        value={
          <Trans>
            {Math.min(100, Math.round(shares[2]! * 100))}% of {usage.cpus} cores
          </Trans>
        }
      />
      <Meter
        label={<Trans>Memory</Trans>}
        share={shares[0]!}
        value={
          <Trans>
            {formatSize(memoryUsed)} of {formatSize(usage.memory.total)}
          </Trans>
        }
      />
      {usage.disk ? (
        <Meter
          label={<Trans>Disk</Trans>}
          share={shares[1]!}
          value={
            <Trans>
              {formatSize(diskUsed)} of {formatSize(usage.disk.total)}
            </Trans>
          }
        />
      ) : null}
      {shares.some((share) => share >= NEARLY_FULL) ? (
        <p className="text-[12.5px] text-destructive">
          <Trans>Almost full. Add a server before adding more bots.</Trans>
        </p>
      ) : null}
      <div className="text-[12.5px] text-muted-foreground">
        <Plural value={running.length} one="# computer running" other="# computers running" />
        {running.length ? (
          <ul className="mt-1 space-y-0.5">
            {running.map((computer, index) => (
              <li
                // Two Spaces can share a name; their order on the server is stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={`${computer.name}-${index}`}
                className="flex justify-between gap-3"
              >
                <span className="truncate">
                  {computer.team ? <Trans>Team · {computer.name}</Trans> : computer.name}
                </span>
                {computer.memory !== null ? (
                  <span className="shrink-0 tabular-nums">{formatSize(computer.memory)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Meter({ label, share, value }: { label: ReactNode; share: number; value: ReactNode }) {
  const percent = Math.max(0, Math.min(100, Math.round(share * 100)));
  return (
    <div>
      <div className="flex justify-between gap-3 text-[12.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${share >= NEARLY_FULL ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
