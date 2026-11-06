import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type {
  ObjectStorageSettings,
  ObjectStorageUpdate,
  ObjectStorageUsage,
  StorageCleanupResult,
} from "@rakazo/contracts";
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
  Field,
  FieldLabel,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useEffect, useId, useState } from "react";
import { formatSize } from "../lib/file-size";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { Shimmer, SuccessPop } from "./ai/primitives";

/** API and worker restart onto a new bucket; poll until the server reports it in use. */
const APPLY_POLL_MS = 3_000;
/** Cleanup cutoffs offered, in days. */
const CLEANUP_AGES = [30, 90, 180, 365] as const;

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
  const [usageRevision, setUsageRevision] = useState(0);

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
  const connected = settings.source !== "none" && settings.active;
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
    <div className="grid gap-4">
      <div data-testid="storage-settings" className="rounded-xl border border-border px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-heading3 font-medium text-foreground">
            <Trans>Storage</Trans>
          </h3>
          {connected ? (
            <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              <Trans>Connected</Trans>
            </span>
          ) : null}
        </div>
        {connected ? <StorageUsage key={usageRevision} /> : null}
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
      <StorageCleanup onCleaned={() => setUsageRevision((revision) => revision + 1)} />
    </div>
  );
}

/** Deletes chat and bot files older than a chosen age, after showing what that would remove. */
function StorageCleanup({ onCleaned }: { onCleaned: () => void }) {
  const { t } = useLingui();
  const ageId = useId();
  const [days, setDays] = useState<number>(CLEANUP_AGES[0]);
  const [preview, setPreview] = useState<StorageCleanupResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleaned, setCleaned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    rpc.objectStorage
      .cleanupPreview({ olderThanDays: days })
      .then((next) => {
        if (alive) setPreview(next);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not check old files`));
      });
    return () => {
      alive = false;
    };
  }, [days, revision, t]);

  async function clean() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.objectStorage.cleanup({ olderThanDays: days });
      setConfirming(false);
      setCleaned(true);
      setRevision((value) => value + 1);
      onCleaned();
    } catch (caught) {
      setError(errorText(caught, t`Could not delete old files`));
    } finally {
      setBusy(false);
    }
  }

  const ageLabel = (age: number) =>
    age === 30 ? t`30 days` : age === 90 ? t`90 days` : age === 180 ? t`6 months` : t`1 year`;
  const files = preview?.files ?? 0;
  const age = ageLabel(days);

  return (
    <div data-testid="storage-cleanup" className="rounded-xl border border-border px-4 py-4">
      <h3 className="text-heading3 font-medium text-foreground">
        <Trans>Clean up</Trans>
      </h3>
      <div className="mt-4 flex items-center justify-between gap-3">
        <label htmlFor={ageId} className="text-[14px] text-foreground">
          <Trans>Files older than</Trans>
        </label>
        <NativeSelect
          id={ageId}
          value={String(days)}
          disabled={busy}
          onChange={(event) => {
            setCleaned(false);
            setError(null);
            setDays(Number(event.target.value));
          }}
        >
          {CLEANUP_AGES.map((age) => (
            <NativeSelectOption key={age} value={String(age)}>
              {ageLabel(age)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-3">
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {!preview ? (
            error ? null : (
              <Shimmer>
                <Trans>Checking…</Trans>
              </Shimmer>
            )
          ) : files ? (
            <>
              <Plural value={files} one="# file" other="# files" /> · {formatSize(preview.bytes)}
            </>
          ) : cleaned ? (
            <SuccessPop label={t`Cleaned up`} />
          ) : (
            <Trans>Nothing to clean up</Trans>
          )}
        </span>
        {files ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            <Trans>Delete</Trans>
          </Button>
        ) : null}
      </div>
      {error && !confirming ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {confirming && preview ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setConfirming(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Plural
                  value={files}
                  one={`Delete # file older than ${age}?`}
                  other={`Delete # files older than ${age}?`}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>They are removed from every chat. This can't be undone.</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void clean()}>
                {busy ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

/** How much of the bucket the server is running on is in use, measured each time it opens. */
function StorageUsage() {
  const { t } = useLingui();
  const [usage, setUsage] = useState<ObjectStorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    rpc.objectStorage
      .usage()
      .then((next) => {
        if (alive) setUsage(next);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not read this bucket`));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (error)
    return (
      <p role="alert" className="mt-3 text-[13px] text-destructive">
        {error}
      </p>
    );
  if (!usage)
    return (
      <p className="mt-3 text-[13px] text-muted-foreground">
        <Shimmer>
          <Trans>Measuring…</Trans>
        </Shimmer>
      </p>
    );

  const other = Math.max(0, usage.bytes - usage.homes - usage.artifacts);
  const parts = [
    { label: t`Workspaces`, bytes: usage.homes, className: "bg-foreground" },
    { label: t`Chat files`, bytes: usage.artifacts, className: "bg-foreground/50" },
    { label: t`Other`, bytes: other, className: "bg-foreground/20" },
  ].filter((part) => part.bytes > 0);
  const total = `${formatSize(usage.bytes)}${usage.partial ? "+" : ""}`;
  const files = usage.objects;

  return (
    <div data-testid="storage-usage" className="mt-4 grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[22px] font-medium tabular-nums text-foreground">{total}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          <Plural value={files} one="# file" other="# files" />
        </span>
      </div>
      {parts.length ? (
        <>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {parts.map((part) => (
              <span
                key={part.label}
                className={part.className}
                style={{ width: `${(part.bytes / usage.bytes) * 100}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            {parts.map((part) => (
              <li key={part.label} className="flex items-center gap-1.5">
                <span aria-hidden className={`size-1.5 rounded-full ${part.className}`} />
                {part.label}
                <span className="tabular-nums text-foreground">{formatSize(part.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
