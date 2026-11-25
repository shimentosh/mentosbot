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
import { Check, ChevronLeft, Copy, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { PluginLogo } from "../components/integrations/plugin-marketplace";
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

type Integration = {
  id: string;
  title: string;
  /** The service's site, for its logo. */
  site: string;
  description: ReactNode;
  /** Keys bots reach from their computers; absent for Google Workspace and MCP. */
  fields?: KeyField[];
};

const GOOGLE: Integration = {
  id: "google-workspace",
  title: "Google Workspace",
  site: "https://workspace.google.com",
  description: <Trans>Gmail, Drive, Sheets, Docs and Calendar</Trans>,
};

/** Services bots reach from their computers with a key their shell commands can read. */
const KEY_INTEGRATIONS: Integration[] = [
  {
    id: "github",
    title: "GitHub",
    site: "https://github.com",
    description: <Trans>Repositories, issues and pull requests</Trans>,
    fields: [{ name: "github-token", label: <Trans>Personal access token</Trans>, secret: true }],
  },
  {
    id: "elevenlabs",
    title: "ElevenLabs",
    site: "https://elevenlabs.io",
    description: <Trans>Voices, speech and sound effects</Trans>,
    fields: [{ name: "elevenlabs-api-key", label: <Trans>API key</Trans>, secret: true }],
  },
  {
    id: "fish-audio",
    title: "Fish Audio",
    site: "https://fish.audio",
    description: <Trans>Voice cloning and speech</Trans>,
    fields: [{ name: "fish-audio-api-key", label: <Trans>API key</Trans>, secret: true }],
  },
  {
    id: "r2",
    title: "Cloudflare R2",
    site: "https://www.cloudflare.com",
    description: <Trans>File storage for bots</Trans>,
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

const MCP: Integration = {
  id: "mcp",
  title: "MCP servers",
  site: "https://modelcontextprotocol.io",
  description: <Trans>Any custom MCP server</Trans>,
};

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

/** Runs one change at a time and keeps its error, for a detail page's buttons. */
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

function useIntegrationData() {
  const userId = useQueryUserId();
  const enabled = Boolean(userId);
  const google = useQuery({ ...googleQuery(userId), enabled }, queryClient);
  const vault = useQuery({ ...vaultQuery(userId), enabled }, queryClient);
  const mcp = useQuery({ ...mcpQuery(userId), enabled }, queryClient);
  const saved = new Set(vault.data?.map((item) => item.name));
  return {
    userId,
    google: google.data,
    googleError: google.error,
    vaultLoaded: Boolean(vault.data),
    saved,
    mcpServers: mcp.data ?? [],
  };
}

function keyConnected(integration: Integration, saved: Set<string>): boolean {
  return Boolean(integration.fields?.every((field) => saved.has(field.name)));
}

export function IntegrationsOverlay({
  onClose,
  onOpenMcp,
}: {
  onClose: () => void;
  onOpenMcp: () => void;
}) {
  const { t } = useLingui();
  const data = useIntegrationData();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = [GOOGLE, ...KEY_INTEGRATIONS].find((integration) => integration.id === openId);
  const status = (integration: Integration): ReactNode => {
    if (integration.id === GOOGLE.id) {
      return data.google?.accounts.length ? (
        <Connected>{data.google.accounts.map((account) => account.email).join(", ")}</Connected>
      ) : null;
    }
    if (integration.id === MCP.id) {
      return data.mcpServers.length ? (
        <Connected>{data.mcpServers.map((server) => server.name).join(", ")}</Connected>
      ) : null;
    }
    return keyConnected(integration, data.saved) ? (
      <Connected>
        <Trans>Connected</Trans>
      </Connected>
    ) : null;
  };
  const added = (integration: Integration) =>
    integration.id === GOOGLE.id
      ? Boolean(data.google?.accounts.length)
      : integration.id === MCP.id
        ? data.mcpServers.length > 0
        : keyConnected(integration, data.saved);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] w-[880px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[880px]"
      >
        <DialogHeader className="flex-row items-center justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pt-4 pb-7">
          {open ? (
            <IntegrationDetail integration={open} onBack={() => setOpenId(null)}>
              {open.id === GOOGLE.id ? (
                <GoogleWorkspaceDetail />
              ) : (
                <KeyIntegrationDetail integration={open} />
              )}
            </IntegrationDetail>
          ) : (
            <div className="grid min-w-0 gap-x-6 gap-y-1 sm:grid-cols-2" data-testid="integrations">
              {[GOOGLE, ...KEY_INTEGRATIONS, MCP].map((integration) => (
                <IntegrationRow
                  key={integration.id}
                  integration={integration}
                  status={status(integration)}
                  added={added(integration)}
                  onOpen={() =>
                    integration.id === MCP.id ? onOpenMcp() : setOpenId(integration.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IntegrationRow({
  integration,
  status,
  added,
  onOpen,
}: {
  integration: Integration;
  status: ReactNode;
  added: boolean;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const mcp = integration.id === MCP.id;
  return (
    <div
      data-testid={`integration-${integration.id}`}
      className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-muted/50"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-start focus-visible:outline-none"
      >
        <PluginLogo name={integration.title} site={integration.site} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-foreground">
            {integration.title}
          </span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {status ?? integration.description}
          </span>
        </span>
      </button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label={mcp ? t`Manage MCP servers` : undefined}
        onClick={onOpen}
      >
        {mcp && added ? <Trans>Manage</Trans> : added ? <Trans>Added</Trans> : <Trans>Add</Trans>}
      </Button>
    </div>
  );
}

function IntegrationDetail({
  integration,
  onBack,
  children,
}: {
  integration: Integration;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <section className="min-w-0 px-2" data-testid={`integration-${integration.id}`}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" aria-label={t`Back`} onClick={onBack}>
          <ChevronLeft />
        </Button>
        <PluginLogo name={integration.title} site={integration.site} large />
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-medium text-foreground">{integration.title}</h3>
          <p className="truncate text-[13px] text-muted-foreground">{integration.description}</p>
        </div>
      </div>
      <div className="mt-6 max-w-[560px]">{children}</div>
    </section>
  );
}

function Connected({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 text-foreground">
      <Check aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function ErrorLine({ error }: { error: string | null | undefined }) {
  return error ? (
    <p role="alert" className="mt-3 text-[13px] text-destructive">
      {error}
    </p>
  ) : null;
}

function GoogleWorkspaceDetail() {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const query = googleQuery(userId);
  const { data, error: loadError } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const [editing, setEditing] = useState(false);
  const { pending, error, run } = useAction();
  const save = (next: GoogleWorkspaceState) => queryClient.setQueryData(query.queryKey, next);
  if (!data) return <ErrorLine error={loadError ? errorText(loadError) : null} />;
  if (!data.clientId || editing) {
    return (
      <>
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
        <ErrorLine error={error} />
      </>
    );
  }
  const signIn = () =>
    void run(async () => {
      await googleSignIn();
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    });
  return (
    <>
      {data.accounts.length ? (
        <ul
          className="divide-y divide-border rounded-xl border border-border"
          data-testid="google-accounts"
        >
          {data.accounts.map((account) => (
            <li key={account.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0 text-[14px]">
                <Connected>{account.email}</Connected>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={t`Disconnect ${account.email}`}
                onClick={() =>
                  void run(async () =>
                    save(await rpc.googleWorkspace.disconnect({ accountId: account.id })),
                  )
                }
              >
                <Trans>Disconnect</Trans>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={`flex items-center justify-between gap-4 ${data.accounts.length ? "mt-3" : ""}`}
      >
        <Button
          variant={data.accounts.length ? "outline" : "default"}
          disabled={pending}
          onClick={signIn}
        >
          {data.accounts.length ? <Trans>Add account</Trans> : <Trans>Connect</Trans>}
        </Button>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-[13px] text-muted-foreground"
          onClick={() => setEditing(true)}
        >
          <Trans>Change OAuth client</Trans>
        </Button>
      </div>
      <ErrorLine error={error} />
    </>
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
      className="space-y-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${ids}-redirect`}>
          <Trans>Redirect URI</Trans>
        </FieldLabel>
        <div className="flex min-w-0 gap-2">
          <Input
            id={`${ids}-redirect`}
            readOnly
            value={state.redirectUri}
            onFocus={(event) => event.target.select()}
            className="min-w-0 font-mono text-[12.5px]"
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
        // Not a sign-in: keep the browser from filling a saved email and password here.
        autoComplete={secret ? "new-password" : "off"}
        data-1p-ignore
        data-lpignore="true"
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

function KeyIntegrationDetail({ integration }: { integration: Integration }) {
  const data = useIntegrationData();
  const fields = integration.fields ?? [];
  const connected = keyConnected(integration, data.saved);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: vaultQuery(data.userId).queryKey });
  if (!data.vaultLoaded) return null;
  if (connected && !editing) {
    return (
      <>
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <span className="min-w-0 font-mono text-[12.5px] text-muted-foreground">
            <Connected>
              {fields.map((field) => `$${commandVariableName(field.name)}`).join(" ")}
            </Connected>
          </span>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(true)}>
              <Trans>Edit</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  for (const field of fields) {
                    if (data.saved.has(field.name)) await rpc.vault.remove({ name: field.name });
                  }
                  await refresh();
                })
              }
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        </div>
        <ErrorLine error={error} />
      </>
    );
  }
  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          for (const field of fields) {
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
      {fields.map((field) => (
        <TextField
          key={field.name}
          label={field.label}
          secret={field.secret}
          value={values[field.name] ?? ""}
          disabled={pending}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        />
      ))}
      <FormButtons pending={pending} onCancel={connected ? () => setEditing(false) : undefined} />
      <ErrorLine error={error} />
    </form>
  );
}
