import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  NetworkExit,
  PageBrowserCommand,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { ComputerServerChoice, ComputerServerRecord } from "@rakazo/db";
import {
  parseServerComputerRef,
  placeOnComputerServer,
  SERVER_COMPUTER_KIND,
  serverComputerRef,
} from "@rakazo/db";
import { cancelComputerRunWork } from "./computer-idle.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";

export interface ComputerServerDirectory {
  /** The servers the computer with this home may use, and where it is now. */
  forHome(homeKey: string): Promise<ComputerServerChoice>;
  byId(id: string): Promise<ComputerServerRecord | null>;
}

type ServerProvider = Pick<
  SandboxProvider,
  Exclude<keyof SandboxProvider, "provisionKind" | "ownsReference" | "billsWhileRunning">
>;

function gone(message: string) {
  const error = new Error(message);
  error.name = "SandboxNotFoundError";
  return error;
}

/**
 * Runs an organization's computers on its own servers, each a Docker supervisor reached over a
 * private network, and everything else on the deployment's own provider. A computer stays on the
 * server it started on; its home is copied in and saved back like any remote computer's, so it
 * can start on another server once its own one is gone.
 */
export class ServerPoolSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];
  private readonly clients = new Map<string, { key: string; provider: Promise<ServerProvider> }>();

  constructor(
    private readonly inner: SandboxProvider,
    private readonly directory: ComputerServerDirectory,
    private readonly secrets: Pick<SecretStore, "load">,
    private readonly options: {
      networkExitFor?: (homeKey: string) => Promise<NetworkExit | undefined>;
      /** Builds the client for one server; tests replace it. */
      connect?: (server: { url: string; token: string }) => ServerProvider;
    } = {},
  ) {
    this.pageBrowser = async (computer, request: PageBrowserCommand, context) => {
      if (computer.kind !== SERVER_COMPUTER_KIND) {
        return inner.pageBrowser
          ? inner.pageBrowser(computer, request, context)
          : {
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            };
      }
      const { provider, ref } = await this.onServer(computer);
      return provider.pageBrowser!(ref, request, context);
    };
  }

  describe() {
    return this.inner.describe();
  }

  ownsReference(computer: Pick<ComputerRef, "kind" | "providerRef">) {
    if (computer.kind === SERVER_COMPUTER_KIND) return true;
    return this.inner.ownsReference?.(computer) ?? true;
  }

  billsWhileRunning(computer: Pick<ComputerRef, "kind">) {
    if (computer.kind === SERVER_COMPUTER_KIND) return false;
    return this.inner.billsWhileRunning?.(computer) ?? false;
  }

  private client(server: ComputerServerRecord): Promise<ServerProvider> {
    const key = `${server.url}\n${server.ciphertext}`;
    const cached = this.clients.get(server.id);
    if (cached?.key === key) return cached.provider;
    const provider = this.secrets
      .load(server.ciphertext, server.secretId)
      .then((token) =>
        this.options.connect
          ? this.options.connect({ url: server.url, token })
          : new DockerSandboxProvider(server.url, token, this.options.networkExitFor),
      );
    this.clients.set(server.id, { key, provider });
    provider.catch(() => {
      if (this.clients.get(server.id)?.provider === provider) this.clients.delete(server.id);
    });
    return provider;
  }

  /** The server holding this computer, with the reference that server knows it by. */
  private async onServer(computer: ComputerRef) {
    const parsed = parseServerComputerRef(computer.providerRef);
    if (!parsed) throw gone("The computer's server reference is invalid");
    const server = await this.directory.byId(parsed.serverId);
    if (!server) throw gone("The computer's server was removed");
    const provider = await this.client(server);
    const ref: ComputerRef = {
      ...computer,
      id: parsed.ref,
      providerRef: parsed.ref,
      kind: "docker",
    };
    return { server, provider, ref };
  }

  private route(computer: ComputerRef) {
    return computer.kind === SERVER_COMPUTER_KIND ? undefined : this.inner;
  }

  async provisionKind(homeKey?: string): Promise<ComputerRef["kind"]> {
    const innerKind =
      (await this.inner.provisionKind?.(homeKey)) ??
      (this.inner.describe().id as ComputerRef["kind"]);
    // A deployment that runs computers on this Mac keeps them there.
    if (!homeKey || innerKind === "desktop") return innerKind;
    return placeOnComputerServer(await this.directory.forHome(homeKey))
      ? SERVER_COMPUTER_KIND
      : innerKind;
  }

  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const innerKind = (await this.inner.provisionKind?.(request.botId)) ?? this.inner.describe().id;
    const placed =
      innerKind === "desktop"
        ? undefined
        : placeOnComputerServer(await this.directory.forHome(request.botId));
    if (!placed) {
      return this.inner.provision(
        {
          ...request,
          providerRef:
            request.providerKind === SERVER_COMPUTER_KIND ? undefined : request.providerRef,
        },
        context,
      );
    }
    const provider = await this.client(placed.server);
    // The server keeps homes under its own data directory, so it chooses the path itself.
    const ref = await provider.provision(
      { ...request, homePath: "", providerRef: placed.ref, providerKind: "docker" },
      context,
    );
    return {
      ...ref,
      kind: SERVER_COMPUTER_KIND,
      id: serverComputerRef(placed.server.id, ref.providerRef),
      providerRef: serverComputerRef(placed.server.id, ref.providerRef),
    };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.isRunning?.(computer, context) ?? false;
    const { provider, ref } = await this.onServer(computer);
    return provider.isRunning?.(ref, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.isStopped?.(computer, context) ?? false;
    const { provider, ref } = await this.onServer(computer);
    return provider.isStopped?.(ref, context) ?? false;
  }

  async hasMountedHome(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.hasMountedHome?.(computer, context) ?? false;
    return false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.environment?.(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.environment?.(ref, context);
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.prepare(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.prepare(ref, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const inner = this.route(computer);
    if (inner) {
      yield* inner.execute(computer, request, context);
      return;
    }
    const { provider, ref } = await this.onServer(computer);
    yield* provider.execute(ref, request, context);
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    const inner = this.route(computer);
    if (inner) return manageComputerWorkspaceDirectories(inner, computer, request, context);
    const { provider, ref } = await this.onServer(computer);
    return manageComputerWorkspaceDirectories(provider as SandboxProvider, ref, request, context);
  }

  async cancelRunWork(
    computer: ComputerRef,
    computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    const inner = this.route(computer);
    if (inner) return cancelComputerRunWork(inner, computer, computerId, runId, context);
    const { provider, ref } = await this.onServer(computer);
    return cancelComputerRunWork(provider as SandboxProvider, ref, computerId, runId, context);
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.connectScreen(computer, request, context);
    const { server, provider, ref } = await this.onServer(computer);
    const session = await provider.connectScreen(ref, request, context);
    if (session.url) assertOnServer(session.url, server.url);
    return session;
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) {
      if (!inner.connectTerminal) throw new Error("terminal is unavailable on this computer");
      return inner.connectTerminal(computer, request, context);
    }
    const { server, provider, ref } = await this.onServer(computer);
    if (!provider.connectTerminal) throw new Error("terminal is unavailable on this computer");
    const terminal = await provider.connectTerminal(ref, request, context);
    assertOnServer(terminal.url, server.url);
    return terminal;
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const inner = this.route(computer);
    if (inner) return inner.setScreenControl?.(computer, interactive, context, controlToken);
    const { provider, ref } = await this.onServer(computer);
    return provider.setScreenControl?.(ref, interactive, context, controlToken);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    const inner = this.route(computer);
    if (inner) return inner.sendInput(computer, input, lease, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.sendInput(ref, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.observe(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.observe(ref, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.act(computer, request, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.act(ref, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.listFiles(computer, path, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.listFiles(ref, path, context);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const inner = this.route(computer);
    if (inner) return inner.readFile(computer, path, context, options);
    const { provider, ref } = await this.onServer(computer);
    return provider.readFile(ref, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.writeFile(computer, file, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.writeFile(ref, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ) {
    const inner = this.route(computer);
    if (inner) {
      yield* inner.exportWorkspace(computer, context, limits);
      return;
    }
    const { provider, ref } = await this.onServer(computer);
    yield* provider.exportWorkspace(ref, context, limits);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    const inner = this.route(computer);
    if (inner) return inner.importWorkspace(computer, files, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.importWorkspace(ref, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.snapshot(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.snapshot(ref, context);
  }

  async keepAlive(computer: ComputerRef) {
    const inner = this.route(computer);
    if (inner) return inner.keepAlive?.(computer);
    const { provider, ref } = await this.onServer(computer);
    return provider.keepAlive?.(ref);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.releaseScreen?.(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.releaseScreen?.(ref, context);
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ) {
    const inner = this.route(computer);
    if (inner) return inner.stop(computer, context, options);
    const { provider, ref } = await this.onServer(computer);
    return provider.stop(ref, context, options);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    const inner = this.route(computer);
    if (inner) return inner.destroy(computer, context);
    const { provider, ref } = await this.onServer(computer);
    return provider.destroy(ref, context);
  }
}

/** A server may only send the browser to itself, never to another address on the network. */
function assertOnServer(url: string, serverUrl: string) {
  if (new URL(url).hostname !== new URL(serverUrl).hostname)
    throw new Error("The computer's server answered with an address that isn't its own");
}

/**
 * Checks that a server answers with this token. A missing computer is the expected answer, so
 * anything but a refused token or no answer at all means the server is ready.
 */
/** What a server's supervisor reports about its load (see its /usage route); null when unreachable. */
export interface SupervisorUsage {
  cpus: number;
  load: number;
  memory: { total: number; available: number };
  disk: { total: number; available: number } | null;
  computers: { key: string; running: boolean; memory: number | null }[];
}

export async function readComputerServerUsage(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<SupervisorUsage | null> {
  const timeout = AbortSignal.timeout(10_000);
  try {
    const res = await fetch(`${url}/usage`, {
      headers: { authorization: `Bearer ${token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = (await res.json()) as SupervisorUsage;
    return Array.isArray(body?.computers) && typeof body.cpus === "number" ? body : null;
  } catch {
    return null;
  }
}

export async function verifyComputerServer(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  const timeout = AbortSignal.timeout(8_000);
  try {
    const res = await fetch(`${url}/computers/rakazo-server-check`, {
      headers: { authorization: `Bearer ${token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return res.status >= 500 ? "unreachable" : "ok";
  } catch {
    return "unreachable";
  }
}
