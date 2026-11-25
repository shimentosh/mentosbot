import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerAccessKeyCreated } from "@rakazo/contracts";
import { COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  SwitchField,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { SquareTerminal, X } from "lucide-react";
import { useId, useState } from "react";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { CopyRow } from "../../routines/routine-editor/trigger-cards";

/** Keys that let an outside AI, such as a desktop assistant, use this bot's computer over MCP. */
export function ComputerAccessKeys({ botId }: { botId: string }) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground">
      <span id={labelId}>
        <Trans>AI access</Trans>
      </span>
      <Button
        variant="outline"
        size="sm"
        aria-describedby={labelId}
        data-testid="computer-access-open"
        onClick={() => setOpen(true)}
      >
        <Trans>Connect an AI</Trans>
      </Button>
      {open ? <AccessKeysDialog botId={botId} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function AccessKeysDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.computer.accessKeys.list.queryOptions({ input: { botId } });
  const listing = useQuery(read);
  const [name, setName] = useState("");
  const [allowCommands, setAllowCommands] = useState(false);
  const [created, setCreated] = useState<ComputerAccessKeyCreated | null>(null);
  const nameId = useId();
  const create = useSave({
    save: (input: { name: string; allowCommands: boolean }, rpc) =>
      rpc.computer.accessKeys.create({ botId, ...input }),
    stale: [read.queryKey],
    onSaved: (saved) => {
      setCreated(saved);
      setName("");
      setAllowCommands(false);
    },
  });
  const remove = useSave({
    save: (keyId: string, rpc) => rpc.computer.accessKeys.remove({ botId, keyId }),
    stale: [read.queryKey],
  });
  const keys = listing.data ?? [];
  const trimmed = name.trim();
  const error = create.error
    ? errorText(create.error, t`Could not create key`)
    : remove.error
      ? errorText(remove.error, t`Could not remove key`)
      : listing.isError
        ? t`Could not load`
        : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="computer-access-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect an AI</Trans>
          </DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="space-y-2" data-testid="computer-access-created">
            <CopyRow label={t`URL`} value={created.url} />
            <CopyRow label={t`Header`} value={`Authorization: Bearer ${created.token}`} />
            <p className="px-0.5 text-body-sm text-muted-foreground">
              <Trans>Add these to your AI's MCP servers. The key is shown only once.</Trans>
            </p>
          </div>
        ) : (
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed && !create.pending) create.run({ name: trimmed, allowCommands });
            }}
          >
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor={nameId}>
                  <Trans>Name</Trans>
                </FieldLabel>
                <Input
                  id={nameId}
                  placeholder={t`Desktop assistant`}
                  value={name}
                  maxLength={COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <SwitchField
                label={<Trans>Allow terminal commands</Trans>}
                checked={allowCommands}
                onCheckedChange={setAllowCommands}
              />
            </FieldGroup>
            <Button
              type="submit"
              className="self-end"
              disabled={!trimmed || create.pending}
              data-testid="computer-access-create"
            >
              <Trans>Create key</Trans>
            </Button>
          </form>
        )}
        {keys.length ? (
          <ul className="divide-y divide-border rounded-xl bg-muted/50">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center gap-2 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-body">{key.name}</span>
                {key.allowCommands ? (
                  <SquareTerminal
                    role="img"
                    aria-label={t`Can run commands`}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                ) : null}
                <span className="shrink-0 text-body-sm text-muted-foreground">
                  {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : t`Never used`}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Remove ${key.name}`}
                  disabled={remove.pending}
                  onClick={() => remove.run(key.id)}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={created ? () => setCreated(null) : onClose}>
            {created ? <Trans>Done</Trans> : <Trans>Close</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
