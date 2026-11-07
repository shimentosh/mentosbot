import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
  readComputerServerUsage,
  ServerSetupError,
  setUpServerOverSsh,
  verifyComputerServer,
} from "@rakazo/adapters";
import type { Actor, ComputerServerStatus, ComputerServerUsage } from "@rakazo/contracts";
import type { ComputerServerRecord } from "@rakazo/db";
import {
  addComputerServer,
  COMPUTER_SERVER_SETUP_LEASE_MS,
  ComputerServerLimitError,
  claimComputerServerSetup,
  findComputerServer,
  listComputerServers,
  recordAuditEvent,
  removeComputerServer,
  runAsSystem,
  updateComputerServer,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isAdmin } from "../admins.js";
import { COMPUTER_SERVER_INSTALL_SCRIPT } from "../computer-server-install.js";
import type { RouterContext } from "./context.js";

/** `host`, `host:port`, `[v6]` or `[v6]:port`, as an admin types where to sign in. */
export function sshTarget(raw: string): { host: string; port: number } {
  const value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  const plain = /^([^:]+)(?::(\d+))?$/.exec(value);
  const match = bracketed ?? plain;
  if (!match) {
    // A bare IPv6 address has no port.
    if (value.includes(":")) return { host: value, port: 22 };
    throw new ORPCError("BAD_REQUEST", { message: "Enter the server's address" });
  }
  const port = match[2] ? Number(match[2]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ORPCError("BAD_REQUEST", { message: "Enter the server's address" });
  return { host: match[1]!, port };
}

/** The supervisor's origin at a private address setup found. */
export function supervisorOrigin(address: string) {
  return `http://${address.includes(":") ? `[${address}]` : address}:7091`;
}

export function computerServerRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /** Deployment admins manage servers wherever this deployment runs Docker computers. */
  const canManage = async (actor: Actor) =>
    deps.sandbox.describe().id === "docker" && (await isAdmin(deps, actor.userId));

  const setupOf = (server: ComputerServerRecord, now: number) => {
    if (server.setupState === "installing") {
      const started = server.setupStartedAt?.getTime() ?? 0;
      if (now - started < COMPUTER_SERVER_SETUP_LEASE_MS)
        return { setup: "installing" as const, setupError: null };
      return { setup: "failed" as const, setupError: "Setup was interrupted" };
    }
    if (server.setupState === "failed")
      return { setup: "failed" as const, setupError: server.setupError };
    return { setup: null, setupError: null };
  };

  const status = async (signal?: AbortSignal): Promise<ComputerServerStatus> => {
    const servers = await listComputerServers(deps.prisma);
    // A set-up server that hasn't answered yet becomes ready the first time it does.
    await Promise.all(
      servers
        .filter((server) => !server.ready && server.url && !server.setupState)
        .map(async (server) => {
          const token = await deps.secrets.load(server.ciphertext, server.secretId);
          if ((await verifyComputerServer(server.url, token, signal)) !== "ok") return;
          await updateComputerServer(deps.prisma, { id: server.id, ready: true });
          server.ready = true;
        }),
    );
    const now = Date.now();
    return {
      canManage: true,
      servers: servers.map((server) => ({
        id: server.id,
        name: server.name,
        host: server.sshHost,
        maxComputers: server.maxComputers,
        computers: server.computers,
        paused: server.paused,
        ready: server.ready,
        ...setupOf(server, now),
      })),
    };
  };

  /** Asks every server how busy it is, and names each computer by its bot or Space. */
  const usage = async (signal?: AbortSignal): Promise<ComputerServerUsage[]> => {
    const servers = await listComputerServers(deps.prisma);
    const targets = [
      {
        id: null,
        name: "",
        url: deps.env.sandboxSupervisorUrl,
        token: deps.env.sandboxSupervisorToken,
      },
      ...(await Promise.all(
        servers
          .filter((server) => server.ready && server.url)
          .map(async (server) => ({
            id: server.id,
            name: server.name,
            url: server.url,
            token: await deps.secrets.load(server.ciphertext, server.secretId),
          })),
      )),
    ];
    const reports = await Promise.all(
      targets.map((target) =>
        target.url && target.token
          ? readComputerServerUsage(target.url, target.token, signal)
          : Promise.resolve(null),
      ),
    );
    const keys = reports.flatMap((report) => report?.computers.map((item) => item.key) ?? []);
    // Computers of every Space on the server, which no one Space's row rules can see.
    const names = await runAsSystem("name the computers on the deployment's servers", async () => {
      const computers = await deps.prisma.computer.findMany({
        where: { homeKey: { in: keys } },
        select: { homeKey: true, scope: true, scopeKey: true, space: { select: { name: true } } },
      });
      const botIds = computers.flatMap((computer) =>
        computer.scopeKey.startsWith("bot:") ? [computer.scopeKey.slice(4)] : [],
      );
      const bots = await deps.prisma.bot.findMany({
        where: { id: { in: botIds } },
        select: { id: true, name: true },
      });
      const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
      return new Map(
        computers.map((computer) => [
          computer.homeKey,
          computer.scope === "team"
            ? { name: computer.space.name, team: true }
            : {
                name: botNames.get(computer.scopeKey.slice(4)) ?? computer.space.name,
                team: false,
              },
        ]),
      );
    });
    return targets.map((target, index) => {
      const report = reports[index];
      return {
        id: target.id,
        name: target.name,
        usage: report
          ? {
              cpus: report.cpus,
              load: report.load,
              memory: report.memory,
              disk: report.disk,
              computers: report.computers.map((item) => ({
                ...(names.get(item.key) ?? { name: item.key, team: item.key.startsWith("team-") }),
                running: item.running,
                memory: item.memory,
              })),
            }
          : null,
      };
    });
  };

  const requireManager = async (actor: Actor) => {
    if (!(await canManage(actor))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  };

  /**
   * Runs past the request: installing Docker and pulling images takes minutes. The claim on the
   * row keeps a second setup of the same server from starting while this one runs.
   */
  const setUp = (
    server: { id: string; sshHost: string; token: string },
    signIn: { username: string; password: string },
  ) => {
    void (async () => {
      const log = getLogger();
      try {
        const target = sshTarget(server.sshHost);
        const { address, hostKey } = await setUpServerOverSsh({
          host: target.host,
          port: target.port,
          username: signIn.username,
          password: signIn.password,
          token: server.token,
          script: COMPUTER_SERVER_INSTALL_SCRIPT,
        });
        const url = supervisorOrigin(address);
        const ready = (await verifyComputerServer(url, server.token)) === "ok";
        await updateComputerServer(deps.prisma, {
          id: server.id,
          url,
          ready,
          sshUser: signIn.username,
          setupState: null,
          setupError: null,
        });
        log.info("computer_server.set_up", { "server.id": server.id, hostKey, ready });
      } catch (error) {
        log.warn("computer_server.setup_failed", {
          "server.id": server.id,
          "error.name": error instanceof Error ? error.name : typeof error,
        });
        await updateComputerServer(deps.prisma, {
          id: server.id,
          setupState: "failed",
          setupError:
            error instanceof ServerSetupError || error instanceof ORPCError
              ? error.message
              : "Setup failed",
        }).catch(() => {});
      }
    })();
  };

  return {
    computerServers: {
      list: authed.computerServers.list.handler(async ({ context }) => {
        if (!(await canManage(context.actor))) return { canManage: false, servers: [] };
        return status(context.signal);
      }),
      add: authed.computerServers.add.handler(async ({ context, input }) => {
        const { actor } = context;
        await requireManager(actor);
        sshTarget(input.host);
        const token = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(token, {
          operationId: "computer-servers.add",
          traceId: "computer-servers.add",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        let id: string;
        try {
          id = await addComputerServer(deps.prisma, {
            userId: actor.userId,
            name: input.name,
            sshHost: input.host,
            sshUser: input.username,
            maxComputers: input.maxComputers,
            secret: { id: stored.id, ciphertext: stored.ciphertext },
          });
        } catch (error) {
          if (error instanceof ComputerServerLimitError)
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          throw error;
        }
        await recordAuditEvent({
          action: "computer_server.added",
          actor: { type: "user", id: actor.userId },
          spaceId: actor.spaceId,
          target: { type: "computer_server", label: input.name },
        });
        if (await claimComputerServerSetup(deps.prisma, id))
          setUp({ id, sshHost: input.host, token }, input);
        return status(context.signal);
      }),
      setup: authed.computerServers.setup.handler(async ({ context, input }) => {
        await requireManager(context.actor);
        const server = await findComputerServer(deps.prisma, input.id);
        if (!server?.sshHost) throw new ORPCError("NOT_FOUND");
        if (await claimComputerServerSetup(deps.prisma, server.id)) {
          const token = await deps.secrets.load(server.ciphertext, server.secretId);
          setUp({ id: server.id, sshHost: server.sshHost, token }, input);
        }
        return status(context.signal);
      }),
      update: authed.computerServers.update.handler(async ({ context, input }) => {
        await requireManager(context.actor);
        if (!(await updateComputerServer(deps.prisma, input))) throw new ORPCError("NOT_FOUND");
        return status(context.signal);
      }),
      usage: authed.computerServers.usage.handler(async ({ context }) => {
        await requireManager(context.actor);
        return usage(context.signal);
      }),
      remove: authed.computerServers.remove.handler(async ({ context, input }) => {
        const { actor } = context;
        await requireManager(actor);
        const removed = await removeComputerServer(deps.prisma, input.id);
        if (!removed) throw new ORPCError("NOT_FOUND");
        await recordAuditEvent({
          action: "computer_server.removed",
          actor: { type: "user", id: actor.userId },
          spaceId: actor.spaceId,
          target: { type: "computer_server", label: removed.name },
        });
        return status(context.signal);
      }),
    },
  };
}
