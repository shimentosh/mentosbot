import { Trans, useLingui } from "@lingui/react/macro";
import type { ProjectFolderStatus } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ExternalLink, FolderCode, X } from "lucide-react";
import { useState } from "react";
import { thisComputer } from "../lib/desktop";
import { queryClient, spaceQueries, useQueryUserId } from "../lib/query";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { FolderPickerDialog } from "./FolderPickerDialog";

/** Names the computer the desktop app runs on, so folder work stays on it. */
async function onThisComputer() {
  const computer = await thisComputer();
  return computer ? { deviceId: computer.deviceId } : {};
}

export function projectFolderQuery(userId: string | null, botId: string) {
  return queryOptions({
    queryKey: [...spaceQueries(userId, selectedSpaceId()).key(), "project-folder", botId],
    queryFn: async () => rpc.projectFolder.get({ botId, ...(await onThisComputer()) }),
  });
}

/**
 * The folder on the owner's own computer this bot works in, and what it keeps running there,
 * such as a dev server. Shown once the owner's desktop app is connected or a folder is set.
 */
export function ProjectFolderSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const query = projectFolderQuery(userId, botId);
  const status = useQuery(
    { ...query, enabled: Boolean(userId), refetchInterval: 15_000 },
    queryClient,
  ).data;
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(work: () => Promise<ProjectFolderStatus>) {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(query.queryKey, await work());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    const computer = await thisComputer();
    if (!computer?.chooseFolder) return setPicking(true);
    const path = await computer.chooseFolder();
    if (path)
      await update(() => rpc.projectFolder.set({ botId, path, deviceId: computer.deviceId }));
  }

  if (!status?.available || (!status.connected && !status.folder)) return null;
  const { folder, processes } = status;
  return (
    <section className="mt-6" data-testid="project-folder">
      <SectionHeading variant="label" className="mb-2">
        <Trans>Project folder</Trans>
      </SectionHeading>
      <div className="space-y-1 rounded-xl bg-muted/50 p-3">
        {folder ? (
          <div className="flex min-h-10 items-center gap-2">
            <FolderCode aria-hidden size={16} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{folder.name}</div>
              <div className="truncate font-mono text-[12px] text-muted-foreground">
                {folder.otherComputer ? t`On ${folder.otherComputer}` : folder.path}
              </div>
            </div>
            {status.connected ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void choose()}>
                <Trans>Change</Trans>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Stop using this folder`}
              disabled={busy}
              onClick={() =>
                void update(async () =>
                  rpc.projectFolder.set({ botId, path: null, ...(await onThisComputer()) }),
                )
              }
            >
              <X aria-hidden size={15} />
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy}
            onClick={() => void choose()}
          >
            <FolderCode aria-hidden size={16} />
            <Trans>Choose folder</Trans>
          </Button>
        )}
        {processes.map((process) => (
          <div
            key={process.name}
            data-testid="kept-command"
            className="flex min-h-10 items-center gap-2 border-t border-border/60 pt-1 text-sm"
          >
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${process.running ? "bg-success" : "bg-muted-foreground/40"}`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate">{process.name}</div>
              <div className="truncate font-mono text-[12px] text-muted-foreground">
                {process.command}
              </div>
            </div>
            {process.running
              ? process.ports.slice(0, 2).map((port) => (
                  <a
                    key={port}
                    href={`http://localhost:${port}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t`Open localhost:${port}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[12px] hover:bg-muted"
                  >
                    {`:${port}`}
                    <ExternalLink aria-hidden size={13} />
                  </a>
                ))
              : null}
            {process.running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void update(async () =>
                    rpc.projectFolder.stop({
                      botId,
                      name: process.name,
                      ...(await onThisComputer()),
                    }),
                  )
                }
              >
                <Trans>Stop</Trans>
              </Button>
            ) : (
              <span className="text-[12px] text-muted-foreground">
                <Trans>Stopped</Trans>
              </span>
            )}
          </div>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {picking ? (
        <FolderPickerDialog
          botId={botId}
          onCancel={() => setPicking(false)}
          onPick={async (path) => {
            queryClient.setQueryData(query.queryKey, await rpc.projectFolder.set({ botId, path }));
            setPicking(false);
          }}
        />
      ) : null}
    </section>
  );
}
