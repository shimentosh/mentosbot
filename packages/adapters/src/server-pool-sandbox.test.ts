import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerServerChoice, ComputerServerRecord } from "@rakazo/db";
import { pickComputerServer } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { ServerPoolSandbox } from "./server-pool-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

function server(id: string, extra: Partial<ComputerServerRecord> = {}): ComputerServerRecord {
  return {
    id,
    name: id,
    url: `http://10.0.0.${id.length}:7091`,
    maxComputers: 2,
    paused: false,
    ready: true,
    sshHost: null,
    sshUser: null,
    setupState: null,
    setupError: null,
    setupStartedAt: null,
    secretId: `secret-${id}`,
    ciphertext: `cipher-${id}`,
    computers: 0,
    ...extra,
  };
}

function fakeProvider(id: string) {
  const provider = {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
      },
    }),
    provisionKind: vi.fn(async () => id as ComputerRef["kind"]),
    provision: vi.fn(async (request: { botId: string; providerRef?: string }) => ({
      id: request.providerRef ?? `${id}-container`,
      botId: request.botId,
      kind: id as ComputerRef["kind"],
      providerRef: request.providerRef ?? `${id}-container`,
    })),
    stop: vi.fn(async () => {}),
    connectScreen: vi.fn(async () => ({
      url: "http://10.0.0.1:32000/embed.html",
      mimeType: "text/html",
      close: async () => {},
    })),
  };
  return provider as typeof provider & SandboxProvider;
}

function pool(choice: ComputerServerChoice, servers = choice.servers) {
  const inner = fakeProvider("docker");
  const clients = new Map<string, ReturnType<typeof fakeProvider>>();
  const tokens: string[] = [];
  const sandbox = new ServerPoolSandbox(
    inner,
    {
      forHome: async () => choice,
      byId: async (id) => servers.find((entry) => entry.id === id) ?? null,
    },
    { load: async (ciphertext) => `token-for-${ciphertext}` },
    {
      connect: ({ url, token }) => {
        tokens.push(token);
        const client = fakeProvider("docker");
        clients.set(url, client);
        return client;
      },
    },
  );
  return { sandbox, inner, clients, tokens };
}

describe("server pool sandbox", () => {
  it("keeps computers on the deployment when the organization has no servers", async () => {
    const { sandbox, inner } = pool({ servers: [] });
    expect(await sandbox.provisionKind("home")).toBe("docker");
    const ref = await sandbox.provision({ botId: "home", homePath: "/data/homes/home" }, ctx);
    expect(ref.kind).toBe("docker");
    expect(inner.provision).toHaveBeenCalledOnce();
  });

  it("places a new computer on the least-used server and names it in the reference", async () => {
    const busy = server("busy", { computers: 1 });
    const idle = server("idle-server", { computers: 0 });
    const { sandbox, clients, tokens, inner } = pool({ servers: [busy, idle] });
    expect(await sandbox.provisionKind("home")).toBe("server");
    const ref = await sandbox.provision({ botId: "home", homePath: "/data/homes/home" }, ctx);
    expect(ref).toMatchObject({
      kind: "server",
      providerRef: "idle-server:docker-container",
      id: "idle-server:docker-container",
    });
    expect(inner.provision).not.toHaveBeenCalled();
    expect(tokens).toEqual(["token-for-cipher-idle-server"]);
    // The server keeps the home in its own data directory.
    expect(clients.get(idle.url)!.provision).toHaveBeenCalledWith(
      expect.objectContaining({ homePath: "", providerKind: "docker", providerRef: undefined }),
      ctx,
    );
  });

  it("skips full, paused and not yet set up servers", async () => {
    const { sandbox } = pool({
      servers: [
        server("full", { computers: 2 }),
        server("paused", { paused: true }),
        server("waiting", { ready: false }),
      ],
    });
    expect(await sandbox.provisionKind("home")).toBe("docker");
  });

  it("keeps a computer on its own server even when that server is full", async () => {
    const own = server("own", { computers: 2 });
    const { sandbox, clients } = pool({
      servers: [own, server("other")],
      current: { kind: "server", providerRef: "own:abc" },
    });
    expect(await sandbox.provisionKind("home")).toBe("server");
    const ref = await sandbox.provision(
      { botId: "home", homePath: "/x", providerRef: "own:abc", providerKind: "server" },
      ctx,
    );
    expect(ref.providerRef).toBe("own:abc");
    expect(clients.get(own.url)!.provision).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "abc" }),
      ctx,
    );
  });

  it("keeps computers on this Mac when the deployment runs them there", async () => {
    const { sandbox, inner } = pool({ servers: [server("free")] });
    inner.provisionKind.mockResolvedValue("desktop");
    expect(await sandbox.provisionKind("home")).toBe("desktop");
    await sandbox.provision({ botId: "home", homePath: "/x" }, ctx);
    expect(inner.provision).toHaveBeenCalledOnce();
  });

  it("sends a server computer's calls to its server under the server's own reference", async () => {
    const own = server("own", { url: "http://10.0.0.1:7091" });
    const { sandbox, clients, inner } = pool({ servers: [own] });
    const computer: ComputerRef = {
      id: "own:abc",
      botId: "home",
      kind: "server",
      providerRef: "own:abc",
    };
    await sandbox.connectScreen(computer, { width: 1, height: 1 } as never, ctx);
    await sandbox.stop(computer, ctx);
    const client = clients.get(own.url)!;
    expect(client.stop).toHaveBeenCalledWith(
      { id: "abc", botId: "home", kind: "docker", providerRef: "abc" },
      ctx,
      undefined,
    );
    expect(inner.stop).not.toHaveBeenCalled();
  });

  it("leaves other computers to the deployment's provider", async () => {
    const { sandbox, inner } = pool({ servers: [server("own")] });
    const computer: ComputerRef = { id: "c", botId: "home", kind: "docker", providerRef: "c" };
    await sandbox.stop(computer, ctx);
    expect(inner.stop).toHaveBeenCalledWith(computer, ctx, undefined);
  });

  it("calls a computer gone once its server is removed, so it starts again elsewhere", async () => {
    const { sandbox } = pool({ servers: [] });
    await expect(
      sandbox.stop({ id: "gone:abc", botId: "home", kind: "server", providerRef: "gone:abc" }, ctx),
    ).rejects.toMatchObject({ name: "SandboxNotFoundError" });
  });

  it("refuses a screen address that points away from the server", async () => {
    const own = server("own", { url: "http://10.0.0.9:7091" });
    const { sandbox } = pool({ servers: [own] });
    await expect(
      sandbox.connectScreen(
        { id: "own:abc", botId: "home", kind: "server", providerRef: "own:abc" },
        {} as never,
        ctx,
      ),
    ).rejects.toThrow("isn't its own");
  });

  it("spreads computers across equally used servers", () => {
    const servers = [server("a"), server("b"), server("c", { computers: 1 })];
    expect(pickComputerServer(servers, () => 0)?.id).toBe("a");
    expect(pickComputerServer(servers, () => 0.99)?.id).toBe("b");
    // Load is relative to each server's size.
    expect(
      pickComputerServer([
        server("small", { computers: 1 }),
        server("big", { maxComputers: 10, computers: 4 }),
      ])?.id,
    ).toBe("big");
  });
});
