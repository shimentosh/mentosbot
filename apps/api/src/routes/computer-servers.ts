import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { verifyComputerServer } from "@rakazo/adapters";
import type { Actor, ComputerServerStatus } from "@rakazo/contracts";
import { isLocalhostOrLoopbackIp, isPrivateNetworkAddress } from "@rakazo/contracts";
import type { ComputerServerRecord } from "@rakazo/db";
import {
  addComputerServer,
  ComputerServerLimitError,
  listComputerServers,
  recordAuditEvent,
  removeComputerServer,
  updateComputerServer,
} from "@rakazo/db";
import { isAdmin } from "../admins.js";
import type { RouterContext } from "./context.js";

/**
 * A server is reached over a private network this deployment shares with it (a cloud VPC or a
 * VPN such as a tailnet): its supervisor speaks plain HTTP, so a public address would expose it.
 */
export function computerServerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Enter the server's address" });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    !isPrivateNetworkAddress(host) ||
    isLocalhostOrLoopbackIp(host)
  )
    throw new ORPCError("BAD_REQUEST", { message: "Use the server's private network address" });
  return `http://${url.host}${url.port ? "" : ":7091"}`;
}

export function computerServerRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /** Deployment admins manage servers wherever this deployment runs Docker computers. */
  const canManage = async (actor: Actor) =>
    deps.sandbox.describe().id === "docker" && (await isAdmin(deps, actor.userId));

  const view = (server: ComputerServerRecord) => ({
    id: server.id,
    name: server.name,
    url: server.url,
    maxComputers: server.maxComputers,
    computers: server.computers,
    paused: server.paused,
    ready: server.ready,
  });

  const status = async (signal?: AbortSignal): Promise<ComputerServerStatus> => {
    const servers = await listComputerServers(deps.prisma);
    // A server waiting for its setup command becomes ready the first time it answers.
    await Promise.all(
      servers
        .filter((server) => !server.ready)
        .map(async (server) => {
          const token = await deps.secrets.load(server.ciphertext, server.secretId);
          if ((await verifyComputerServer(server.url, token, signal)) !== "ok") return;
          await updateComputerServer(deps.prisma, { id: server.id, ready: true });
          server.ready = true;
        }),
    );
    return { canManage: true, servers: servers.map(view) };
  };

  const requireManager = async (actor: Actor) => {
    if (!(await canManage(actor))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
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
        const url = computerServerOrigin(input.url);
        const token = randomBytes(32).toString("base64url");
        const stored = await deps.secrets.put(token, {
          operationId: "computer-servers.add",
          traceId: "computer-servers.add",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        try {
          await addComputerServer(deps.prisma, {
            userId: actor.userId,
            name: input.name,
            url,
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
        return { status: await status(context.signal), token };
      }),
      update: authed.computerServers.update.handler(async ({ context, input }) => {
        await requireManager(context.actor);
        if (!(await updateComputerServer(deps.prisma, input))) throw new ORPCError("NOT_FOUND");
        return status(context.signal);
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
