import { Trans, useLingui } from "@lingui/react/macro";
import type { GoogleWorkspaceState } from "@rakazo/contracts";
import { commandVariableName } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { GOOGLE_WORKSPACE_CHANNEL } from "../lib/google-workspace-channel";
import { queryClient, spaceQueries, useQueryUserId } from "../lib/query";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

function integrationQuery<T>(userId: string | null, key: string, queryFn: () => Promise<T>) {
  return queryOptions({
    queryKey: [...spaceQueries(userId, selectedSpaceId()).key(), "integrations", key],
    queryFn,
  });
}

const googleQuery = (userId: string | null) =>
  integrationQuery(userId, "google-workspace", () => rpc.googleWorkspace.get());
const vaultQuery = (userId: string | null) =>
  integrationQuery(userId, "vault", () => rpc.vault.list());
const mcpQuery = (userId: string | null) =>
  integrationQuery(userId, "mcp", () => rpc.mcp.servers.list());

type KeyField = {
  /** Vault name; bots' shell commands read it as an environment variable. */
  name: string;
  label: ReactNode;
  secret?: boolean;
  /** Turns what the person typed into the stored value. */
  toValue?: (input: string) => string;
};

type KeyIntegration = { id: string; title: string; fields: KeyField[] };

/** Services bots reach from their computers with a key their shell commands can read. */
const KEY_INTEGRATIONS: KeyIntegration[] = [
  {
    id: "github",
    title: "GitHub",
    fields: [{ name: "github-token", label: <Trans>Personal access token</Trans>, secret: true }],
  },
  {
    id: "elevenlabs",
    title: "ElevenLabs",
    fields: [{ name: "elevenlabs-api-key", label: <Trans>API key</Trans>, secret: true }],
  },
  {
    id: "fish-audio",
    title: "Fish Audio",
    fields: [{ name: "fish-audio-api-key", label: <Trans>API key</Trans>, secret: true }],
  },
  {
    id: "r2",
    title: "Cloudflare R2",
    fields: [
      {
        name: "r2-endpoint",
        label: <Trans>Account ID</Trans>,
        toValue: (accountId) => `https://${accountId}.r2.cloudflarestorage.com`,
      },
      { name: "r2-bucket", label: <Trans>Bucket</Trans> },
      { name: "r2-access-key-id", label: <Trans>Access key ID</Trans> },
      { name: "r2-secret-access-key", label: <Trans>Secret access key</Trans>, secret: true },
    ],
  },
];

/** Open Google's sign-in and resolve once the callback page reports back or the popup closes. */
async function googleSignIn(): Promise<void> {
  const { authorizationUrl } = await rpc.googleWorkspace.begin();
  const popup = window.open(
    authorizationUrl,
    GOOGLE_WORKSPACE_CHANNEL,
    "popup,width=520,height=720",
  );
  if (!popup) {
    // Popup blocked: sign in in this tab; the callback page comes back to the app.
    window.location.assign(authorizationUrl);
    return;
  }
  await new Promise<void>((resolve) => {
    const channel = new BroadcastChannel(GOOGLE_WORKSPACE_CHANNEL);
    const finish = () => {
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      channel.close();
      resolve();
    };
    // Google's pages sever window.opener, but a closed popup lets focus come back here.
    const poll = window.setInterval(() => {
      if (popup.closed && document.hasFocus()) finish();
    }, 500);
    const timeout = window.setTimeout(finish, SIGN_IN_TIMEOUT_MS);
    channel.onmessage = finish;
  });
}

/** Runs one change at a time and keeps its error, for a card's buttons. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<unknown>): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

export function IntegrationsOverlay({
  onClose,
  onOpenMcp,
}: {
  onClose: () => void;
  onOpenMcp: () => void;
}) {
  const { t } = useLingui();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100%-2rem)] w-[600px] max-w-[calc(100%-2rem)] gap-0 overflow-y-auto rounded-2xl bg-card p-0 sm:max-w-[600px]"
      >
        <DialogHeader className="flex-row items-center justify-between px-7 pt-6">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="space-y-3 p-7 pt-5">
          <GoogleWorkspaceCard />
          {KEY_INTEGRATIONS.map((integration) => (
            <KeyIntegrationCard key={integration.id} integration={integration} />
          ))}
          <McpCard onOpen={onOpenMcp} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationCard({
  id,
  title,
  detail,
  action,
  error,
  children,
}: {
  id: string;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  error?: string | null;
  children?: ReactNode;
}) {
  const titleId = `integration-${id}-title`;
  return (
    <section
      className="rounded-xl border border-border px-5 py-4"
      data-testid={`integration-${id}`}
      aria-labelledby={titleId}
    >
      <div className="flex min-h-9 items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[15px] font-medium text-foreground">
            {title}
          </h3>
          {detail ? (
            <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{detail}</div>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Connected({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-foreground">
      <Check aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function GoogleWorkspaceCard() {
  const userId = useQueryUserId();
  const query = googleQuery(userId);
  const { data, error: loadError } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useAction();
  const save = (next: GoogleWorkspaceState) => queryClient.setQueryData(query.queryKey, next);
  const showForm = Boolean(data && (!data.clientId || editing));
  return (
    <IntegrationCard
      id="google-workspace"
      title="Google Workspace"
      detail={
        data?.account ? (
          <Connected>{data.account.email}</Connected>
        ) : (
          <Trans>Gmail, Drive, Sheets, Docs and Calendar</Trans>
        )
      }
      error={error ?? (loadError ? errorText(loadError) : null)}
      action={
        data?.clientId && !showForm ? (
          data.account ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void run(async () => save(await rpc.googleWorkspace.disconnect()))}
            >
              <Trans>Disconnect</Trans>
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await googleSignIn();
                  await queryClient.invalidateQueries({ queryKey: query.queryKey });
                })
              }
            >
              <Trans>Connect</Trans>
            </Button>
          )
        ) : null
      }
    >
      {data && showForm ? (
        <GoogleClientForm
          state={data}
          pending={pending}
          onCancel={data.clientId ? () => setEditing(false) : undefined}
          onSave={async (client) => {
            if (await run(async () => save(await rpc.googleWorkspace.saveClient(client)))) {
              setEditing(false);
            }
          }}
        />
      ) : null}
      {data?.clientId && !showForm ? (
        <Button
          variant="link"
          size="sm"
          className="mt-2 h-auto p-0 text-[13px] text-muted-foreground"
          onClick={() => setEditing(true)}
        >
          <Trans>Change OAuth client</Trans>
        </Button>
      ) : null}
    </IntegrationCard>
  );
}

function GoogleClientForm({
  state,
  pending,
  onSave,
  onCancel,
}: {
  state: GoogleWorkspaceState;
  pending: boolean;
  onSave: (client: { clientId: string; clientSecret: string }) => void;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [clientId, setClientId] = useState(state.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, copy] = useCopyText();
  useEffect(() => setClientId(state.clientId ?? ""), [state.clientId]);
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${ids}-redirect`}>
          <Trans>Redirect URI</Trans>
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id={`${ids}-redirect`}
            readOnly
            value={state.redirectUri}
            onFocus={(event) => event.target.select()}
            className="font-mono text-[12.5px]"
          />
          <Button
            type="button"
            variant="outline"
            aria-label={copied ? t`Copied` : t`Copy redirect URI`}
            onClick={() => copy(state.redirectUri)}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </Field>
      <TextField
        label={<Trans>Client ID</Trans>}
        value={clientId}
        disabled={pending}
        onChange={setClientId}
      />
      <TextField
        label={<Trans>Client secret</Trans>}
        secret
        value={clientSecret}
        disabled={pending}
        onChange={setClientSecret}
      />
      <FormButtons pending={pending} onCancel={onCancel} />
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  secret,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  secret?: boolean;
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
        required
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function FormButtons({ pending, onCancel }: { pending: boolean; onCancel?: () => void }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" disabled={pending}>
        <Trans>Save</Trans>
      </Button>
      {onCancel ? (
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function KeyIntegrationCard({ integration }: { integration: KeyIntegration }) {
  const userId = useQueryUserId();
  const query = vaultQuery(userId);
  const { data } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const saved = new Set(data?.map((item) => item.name));
  const connected = integration.fields.every((field) => saved.has(field.name));
  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
  return (
    <IntegrationCard
      id={integration.id}
      title={integration.title}
      detail={
        connected ? (
          <Connected>
            {integration.fields.map((field) => `$${commandVariableName(field.name)}`).join(" ")}
          </Connected>
        ) : null
      }
      error={error}
      action={
        editing ? null : connected ? (
          <>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(true)}>
              <Trans>Edit</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  for (const field of integration.fields) {
                    if (saved.has(field.name)) await rpc.vault.remove({ name: field.name });
                  }
                  await refresh();
                })
              }
            >
              <Trans>Disconnect</Trans>
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={pending || !data} onClick={() => setEditing(true)}>
            <Trans>Connect</Trans>
          </Button>
        )
      }
    >
      {editing ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              for (const field of integration.fields) {
                const input = values[field.name]?.trim() ?? "";
                await rpc.vault.put({
                  destination: { name: field.name, origin: "", auth: { type: "command" } },
                  value: field.toValue ? field.toValue(input) : input,
                  title: integration.title,
                });
              }
              await refresh();
            }).then((ok) => {
              if (!ok) return;
              setValues({});
              setEditing(false);
            });
          }}
        >
          {integration.fields.map((field) => (
            <TextField
              key={field.name}
              label={field.label}
              secret={field.secret}
              value={values[field.name] ?? ""}
              disabled={pending}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
          <FormButtons pending={pending} onCancel={() => setEditing(false)} />
        </form>
      ) : null}
    </IntegrationCard>
  );
}

function McpCard({ onOpen }: { onOpen: () => void }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const { data } = useQuery({ ...mcpQuery(userId), enabled: Boolean(userId) }, queryClient);
  return (
    <IntegrationCard
      id="mcp"
      title={t`MCP servers`}
      detail={
        data?.length ? <Connected>{data.map((server) => server.name).join(", ")}</Connected> : null
      }
      action={
        <Button variant="outline" size="sm" aria-label={t`Manage MCP servers`} onClick={onOpen}>
          {data?.length ? <Trans>Manage</Trans> : <Trans>Add</Trans>}
        </Button>
      }
    />
  );
}
