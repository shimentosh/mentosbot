import { Trans, useLingui } from "@lingui/react/macro";
import type { NetworkExitDescriptor, NetworkExitStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { queryClient, spaceQueries, useQueryUserId } from "../lib/query";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** The signed-in person's own network for their computers in the current Space. */
export function networkExitQuery(userId: string | null) {
  return queryOptions({
    queryKey: [...spaceQueries(userId, selectedSpaceId()).key(), "network-exit"],
    queryFn: () => rpc.networkExit.get(),
  });
}

export function useNetworkExit() {
  const userId = useQueryUserId();
  return useQuery({ ...networkExitQuery(userId), enabled: Boolean(userId) }, queryClient).data;
}

export function NetworkExitDialog({
  provider,
  status,
  onClose,
}: {
  provider: NetworkExitDescriptor;
  status: NetworkExitStatus;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const connected = status.connection?.provider === provider.id ? status.connection : null;
  const [values, setValues] = useState<Record<string, string>>(connected?.values ?? {});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<NetworkExitStatus>) {
    setPending(true);
    setError(null);
    try {
      queryClient.setQueryData(networkExitQuery(userId).queryKey, await work());
      onClose();
    } catch (reason) {
      setError(errorText(reason));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{provider.displayName}</DialogTitle>
          <DialogDescription>
            {connected ? (
              <Trans>Your computers' browsers use this network when they start.</Trans>
            ) : (
              <Trans>Send your computers' browsers through a network of your own.</Trans>
            )}{" "}
            {provider.helpUrl ? (
              <a
                href={provider.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                <Trans>Setup guide</Trans>
              </a>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => rpc.networkExit.connect({ provider: provider.id, values }));
          }}
        >
          {provider.fields.map((field) => (
            <NetworkField
              key={field.key}
              label={field.label}
              secret={field.kind === "secret"}
              required={field.required && !(connected && field.kind === "secret")}
              placeholder={connected && field.kind === "secret" ? t`Saved` : undefined}
              value={values[field.key] ?? ""}
              disabled={pending}
              onChange={(value) => {
                setValues((current) => ({ ...current, [field.key]: value }));
                setError(null);
              }}
            />
          ))}
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {connected ? <Trans>Save</Trans> : <Trans>Connect</Trans>}
            </Button>
            {connected ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void run(() => rpc.networkExit.disconnect())}
              >
                <Trans>Disconnect</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NetworkField({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required: boolean;
  secret: boolean;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
