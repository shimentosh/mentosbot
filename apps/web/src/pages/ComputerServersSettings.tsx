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
import { Ellipsis, Plus } from "lucide-react";
import { useId, useState } from "react";
import { Shimmer } from "../components/ai/primitives";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
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
      // Setup runs on the server for minutes; follow it until every server settles.
      refetchInterval: (current) =>
        current.state.data?.servers.some(
          (server) => server.setup === "installing" || (!server.ready && !server.setup),
        )
          ? 5_000
          : false,
    },
    queryClient,
  );
  const [adding, setAdding] = useState(false);
  const [retrying, setRetrying] = useState<ComputerServer | null>(null);
  const [removing, setRemoving] = useState<ComputerServer | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data?.canManage) return null;
  const saved = (status: ComputerServerStatus) => queryClient.setQueryData(query.queryKey, status);
  const run = async (work: () => Promise<ComputerServerStatus>) => {
    setError(null);
    try {
      saved(await work());
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
                  <ServerState server={server} />
                </span>
              }
              control={
                <ServerMenu
                  server={server}
                  onPause={(paused) =>
                    void run(() => rpc.computerServers.update({ id: server.id, paused }))
                  }
                  onRetry={() => setRetrying(server)}
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
      {adding ? <ServerDialog onSaved={saved} onClose={() => setAdding(false)} /> : null}
      {retrying ? (
        <ServerDialog server={retrying} onSaved={saved} onClose={() => setRetrying(null)} />
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

function ServerState({ server }: { server: ComputerServer }) {
  const detail = "truncate text-[12.5px] text-muted-foreground";
  if (server.setup === "installing")
    return (
      <span className={detail}>
        <Shimmer>
          <Trans>Setting up…</Trans>
        </Shimmer>
      </span>
    );
  if (server.setup === "failed")
    return (
      <span className="text-[12.5px] text-destructive">
        {server.setupError ?? <Trans>Setup failed</Trans>}
      </span>
    );
  if (!server.ready)
    return (
      <span className={detail}>
        <Trans>Not answering</Trans>
      </span>
    );
  return (
    <span className={detail}>
      <Plural
        value={server.maxComputers}
        one={`${server.computers} of # computer`}
        other={`${server.computers} of # computers`}
      />
      {server.paused ? (
        <>
          {" · "}
          <Trans>Paused</Trans>
        </>
      ) : null}
    </span>
  );
}

function ServerMenu({
  server,
  onPause,
  onRetry,
  onRemove,
}: {
  server: ComputerServer;
  onPause: (paused: boolean) => void;
  onRetry: () => void;
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
        {server.ready ? (
          <DropdownMenuItem onClick={() => onPause(!server.paused)}>
            {server.paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
          </DropdownMenuItem>
        ) : null}
        {server.setup !== "installing" && server.host ? (
          <DropdownMenuItem onClick={onRetry}>
            <Trans>Set up again</Trans>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trans>Remove</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Adds a server, or with one given, signs in to it again and reruns its setup. */
function ServerDialog({
  server,
  onSaved,
  onClose,
}: {
  server?: ComputerServer;
  onSaved: (status: ComputerServerStatus) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [maxComputers, setMaxComputers] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = Number(maxComputers);
  const valid =
    username.trim() !== "" &&
    password !== "" &&
    (server ||
      (name.trim() !== "" &&
        host.trim() !== "" &&
        Number.isInteger(max) &&
        max >= 1 &&
        max <= 500));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        server
          ? await rpc.computerServers.setup({ id: server.id, username, password })
          : await rpc.computerServers.add({ name, host, username, password, maxComputers: max }),
      );
      onClose();
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
            {server ? <Trans>Set up {server.name} again</Trans> : <Trans>Add server</Trans>}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !busy) void submit();
          }}
        >
          {server ? null : (
            <>
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
                <FieldLabel htmlFor={`${id}-host`}>
                  <Trans>IP address</Trans>
                </FieldLabel>
                <Input
                  id={`${id}-host`}
                  value={host}
                  placeholder="203.0.113.7"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setHost(event.target.value)}
                />
              </Field>
            </>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-user`}>
              <Trans>Username</Trans>
            </FieldLabel>
            <Input
              id={`${id}-user`}
              value={username}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-password`}>
              <Trans>Password</Trans>
            </FieldLabel>
            <Input
              id={`${id}-password`}
              type="password"
              value={password}
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {server ? null : (
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
          )}
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
              {server ? <Trans>Set up</Trans> : <Trans>Add</Trans>}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
