import { Trans, useLingui } from "@lingui/react/macro";
import type { ObjectStorageSettings, ObjectStorageUpdate } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, Label, Switch } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { Shimmer, SuccessPop } from "./ai/primitives";

/** API and worker restart onto a new bucket; poll until the server reports it in use. */
const APPLY_POLL_MS = 3_000;

function draftFrom(settings: ObjectStorageSettings): ObjectStorageUpdate {
  return {
    endpoint: settings.endpoint,
    bucket: settings.bucket,
    region: settings.region,
    prefix: settings.prefix,
    pathStyle: settings.pathStyle,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: "",
  };
}

/** Admin choice of the bucket that holds bot files and artifacts. */
export function StorageSettingsPanel() {
  const { t } = useLingui();
  const pathStyleId = useId();
  const [settings, setSettings] = useState<ObjectStorageSettings | null>(null);
  const [draft, setDraft] = useState<ObjectStorageUpdate | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.objectStorage
      .get()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setDraft(draftFrom(next));
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load storage settings`));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const applying = settings?.source === "settings" && !settings.active;
  useEffect(() => {
    if (!applying) return;
    // The server restarts while it switches, so failed checks are expected until it is back.
    const timer = window.setInterval(() => {
      rpc.objectStorage
        .get()
        .then(setSettings)
        .catch(() => undefined);
    }, APPLY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [applying]);

  if (!draft || !settings) {
    return error ? (
      <p role="alert" className="mt-3 text-[13px] text-destructive">
        {error}
      </p>
    ) : null;
  }

  const fromEnvironment = settings.source === "environment";
  // Saved files live in this bucket, so only its keys and addressing can change.
  const locked = fromEnvironment || settings.source === "settings";
  const set = (patch: Partial<ObjectStorageUpdate>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  async function save() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await rpc.objectStorage.update(draft);
      setSettings(next);
      setDraft(draftFrom(next));
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, t`Could not save storage settings`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="storage-settings" className="rounded-xl border border-border px-4 py-4">
      <h3 className="text-heading3 font-medium text-foreground">
        <Trans>Storage</Trans>
      </h3>
      {fromEnvironment ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          <Trans>Set by the server environment.</Trans>
        </p>
      ) : null}
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={fromEnvironment || pending} className="grid gap-3">
          <TextField
            label={t`Endpoint`}
            type="url"
            value={draft.endpoint}
            onChange={(endpoint) => set({ endpoint })}
            placeholder="https://"
            required
            disabled={locked}
          />
          <TextField
            label={t`Bucket`}
            value={draft.bucket}
            onChange={(bucket) => set({ bucket })}
            required
            disabled={locked}
          />
          <TextField
            label={t`Access key ID`}
            value={draft.accessKeyId}
            onChange={(accessKeyId) => set({ accessKeyId })}
            required
          />
          <TextField
            label={t`Secret access key`}
            secret
            value={draft.secretAccessKey}
            onChange={(secretAccessKey) => set({ secretAccessKey })}
            placeholder={settings.hasSecret ? t`Saved` : undefined}
            required={!settings.hasSecret}
          />
          <Collapsible>
            <CollapsibleTrigger className="text-[13px] text-muted-foreground">
              <Trans>Advanced</Trans>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 grid gap-3">
              <TextField
                label={t`Region`}
                value={draft.region}
                onChange={(region) => set({ region })}
              />
              <TextField
                label={t`Folder`}
                value={draft.prefix}
                onChange={(prefix) => set({ prefix })}
                disabled={locked}
              />
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={pathStyleId} className="text-[14px] font-normal text-foreground">
                  <Trans>Bucket name in path</Trans>
                </Label>
                <Switch
                  id={pathStyleId}
                  checked={draft.pathStyle}
                  onCheckedChange={(pathStyle) => set({ pathStyle })}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </fieldset>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        {fromEnvironment ? null : (
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={pending || applying}>
              <Trans>Save</Trans>
            </Button>
            {applying ? (
              <span className="text-[13px] text-muted-foreground">
                <Shimmer>
                  <Trans>Switching storage…</Trans>
                </Shimmer>
              </span>
            ) : saved ? (
              <SuccessPop label={t`Saved`} />
            ) : null}
          </div>
        )}
      </form>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  disabled,
  secret,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  secret?: boolean;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : type}
        autoComplete={secret ? "off" : undefined}
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
