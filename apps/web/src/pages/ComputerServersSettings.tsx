import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ComputerServer, ComputerServerStatus } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Check, Copy, Ellipsis, Plus } from "lucide-react";
import { useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { useCopyText } from "../lib/copy-text";
import { queryClient, useQueryUserId } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

function computerServersQuery(userId: string | null) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "computer-servers"],
    queryFn: () => rpc.computerServers.list(),
  });
}

/** The deployment's own servers for bots' computers; only deployment admins manage them. */
export function ComputerServersSettings() {
  const userId = useQueryUserId();
  const query = computerServersQuery(userId);
  const { data } = useQuery(
    {
      ...query,
      enabled: Boolean(userId),
      // A server waiting for its setup command turns ready on its own.
      refetchInterval: (current) =>
        current.state.data?.servers.some((server) => !server.ready) ? 5_000 : false,
    },
    queryClient,
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ComputerServer | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data?.canManage) return null;
  const run = async (work: () => Promise<ComputerServerStatus>) => {
    setError(null);
    try {
      queryClient.setQueryData(query.queryKey, await work());
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <div className="mt-4 space-y-3" data-testid="computer-servers">
      {data.servers.length > 0 ? (
        <SettingsGroup title={<Trans>Servers</Trans>}>
          {data.servers.map((server) => (
            <SettingsRow
              key={server.id}
              label={
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{server.name}</span>
                  <span className="truncate text-[12.5px] text-muted-foreground">
                    <Plural
                      value={server.maxComputers}
                      one={`${server.computers} of # computer`}
                      other={`${server.computers} of # computers`}
                    />
                    {!server.ready ? (
                      <>
                        {" · "}
                        <Trans>Waiting for setup</Trans>
                      </>
                    ) : server.paused ? (
                      <>
                        {" · "}
                        <Trans>Paused</Trans>
                      </>
                    ) : null}
                  </span>
                </span>
              }
              control={
                <ServerMenu
                  server={server}
                  onPause={(paused) =>
                    void run(() => rpc.computerServers.update({ id: server.id, paused }))
                  }
                  onRemove={() => setRemoving(server)}
                />
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
      {error ? (
        <p role="alert" className="px-1 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <Button variant="outline" className="rounded-full" onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" />
        <Trans>Add server</Trans>
      </Button>
      {adding ? (
        <AddServerDialog
          onAdded={(status) => queryClient.setQueryData(query.queryKey, status)}
          onClose={() => setAdding(false)}
        />
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Remove {removing?.name ?? ""}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Its computers start on another server next time.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const server = removing;
                setRemoving(null);
                if (server) void run(() => rpc.computerServers.remove({ id: server.id }));
              }}
            >
              <Trans>Remove</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ServerMenu({
  server,
  onPause,
  onRemove,
}: {
  server: ComputerServer;
  onPause: (paused: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t`Options for ${server.name}`} />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onPause(!server.paused)}>
          {server.paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trans>Remove</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddServerDialog({
  onAdded,
  onClose,
}: {
  onAdded: (status: ComputerServerStatus) => void;
  onClose: () => void;
}) {
  const id = useId();
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [maxComputers, setMaxComputers] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const max = Number(maxComputers);
  const valid =
    name.trim() !== "" && url.trim() !== "" && Number.isInteger(max) && max >= 1 && max <= 500;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const added = await rpc.computerServers.add({ name, url, maxComputers: max });
      onAdded(added.status);
      const address = new URL(url.includes("://") ? url : `http://${url}`).hostname;
      setCommand(
        `curl -fsSL ${window.location.origin}/api/computer-servers/install.sh | sudo bash -s -- --token ${added.token} --address ${address.replace(/^\[|\]$/g, "")}`,
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Add server</Trans>
          </DialogTitle>
        </DialogHeader>
        {command ? (
          <div className="space-y-4">
            <Field>
              <FieldLabel>
                <Trans>Run this on the server</Trans>
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={command}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t`Copy command`}
                  onClick={() => copy(command)}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            </Field>
            <div className="flex justify-end">
              <Button onClick={onClose}>
                <Trans>Done</Trans>
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !busy) void submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-url`}>
                <Trans>Private address</Trans>
              </FieldLabel>
              <Input
                id={`${id}-url`}
                value={url}
                placeholder="10.0.0.2"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-max`}>
                <Trans>Computers</Trans>
              </FieldLabel>
              <Input
                id={`${id}-max`}
                type="number"
                min={1}
                max={500}
                value={maxComputers}
                onChange={(event) => setMaxComputers(event.target.value)}
              />
            </Field>
            {error ? (
              <p role="alert" className="text-[12.5px] text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" disabled={!valid || busy}>
                <Trans>Add</Trans>
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
