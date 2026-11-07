import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { runAsSystem } from "./row-security.js";

/** The kind of a computer placed on one of the deployment's own servers. */
export const SERVER_COMPUTER_KIND = "server";
/** At most this many servers per deployment. */
export const MAX_COMPUTER_SERVERS = 100;
export const COMPUTER_SERVER_SECRET_KIND = "computer-server";

export interface ComputerServerRecord {
  id: string;
  name: string;
  url: string;
  maxComputers: number;
  paused: boolean;
  ready: boolean;
  sshHost: string | null;
  sshUser: string | null;
  setupState: string | null;
  setupError: string | null;
  setupStartedAt: Date | null;
  secretId: string;
  ciphertext: string;
  /** Computers placed on it, running or not. */
  computers: number;
}

export interface ComputerServerChoice {
  servers: ComputerServerRecord[];
  /** Where the computer is now, when one exists. */
  current?: { kind: string; providerRef: string | null };
}

export class ComputerServerLimitError extends Error {
  constructor() {
    super(`Up to ${MAX_COMPUTER_SERVERS} servers can be added`);
    this.name = "ComputerServerLimitError";
  }
}

/** A server computer's provider ref names its server before the server's own reference. */
export function serverComputerRef(serverId: string, ref: string) {
  return `${serverId}:${ref}`;
}

export function parseServerComputerRef(providerRef: string) {
  const split = providerRef.indexOf(":");
  if (split <= 0 || split === providerRef.length - 1) return undefined;
  return { serverId: providerRef.slice(0, split), ref: providerRef.slice(split + 1) };
}

const SELECT = {
  id: true,
  name: true,
  url: true,
  maxComputers: true,
  paused: true,
  ready: true,
  sshHost: true,
  sshUser: true,
  setupState: true,
  setupError: true,
  setupStartedAt: true,
  secretId: true,
  secret: { select: { ciphertext: true } },
} as const;

async function loadServers(prisma: PrismaClient, where: Prisma.ComputerServerWhereInput = {}) {
  const servers = await prisma.computerServer.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: SELECT,
  });
  if (servers.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ serverId: string; count: bigint }>>(Prisma.sql`
    SELECT split_part("providerRef", ':', 1) AS "serverId", count(*) AS count
    FROM "computers"
    WHERE "kind" = ${SERVER_COMPUTER_KIND}
      AND "providerRef" IS NOT NULL
      AND split_part("providerRef", ':', 1) IN (${Prisma.join(servers.map((server) => server.id))})
    GROUP BY 1
  `);
  const counts = new Map(rows.map((row) => [row.serverId, Number(row.count)]));
  return servers.map(({ secret, ...server }) => ({
    ...server,
    ciphertext: secret.ciphertext,
    computers: counts.get(server.id) ?? 0,
  }));
}

export function listComputerServers(prisma: PrismaClient): Promise<ComputerServerRecord[]> {
  return runAsSystem("list computer servers", () => loadServers(prisma));
}

export function findComputerServer(
  prisma: PrismaClient,
  id: string,
): Promise<ComputerServerRecord | null> {
  return runAsSystem("read a computer server", async () => {
    return (await loadServers(prisma, { id }))[0] ?? null;
  });
}

/** The servers the computer with this home may use, and where it is now. */
export function computerServersForHome(
  prisma: PrismaClient,
  homeKey: string,
): Promise<ComputerServerChoice> {
  return runAsSystem("list the computer servers a computer may use", async () => {
    const computer = await prisma.computer.findUnique({
      where: { homeKey },
      select: { kind: true, providerRef: true },
    });
    const servers = await loadServers(prisma);
    return computer ? { servers, current: computer } : { servers };
  });
}

/** A ready, unpaused server below its computer count. */
export function takesNewComputers(
  server: Pick<ComputerServerRecord, "paused" | "ready" | "computers" | "maxComputers">,
) {
  return server.ready && !server.paused && server.computers < server.maxComputers;
}

/** The least-used ready server that still takes new computers; ties go to a random one. */
export function pickComputerServer<
  T extends Pick<ComputerServerRecord, "paused" | "ready" | "computers" | "maxComputers">,
>(servers: readonly T[], random: () => number = Math.random): T | undefined {
  const open = servers.filter(takesNewComputers);
  if (open.length === 0) return undefined;
  const load = (server: T) => server.computers / server.maxComputers;
  const least = Math.min(...open.map(load));
  // Starts on several instances at once spread out instead of all landing on the same server.
  const tied = open.filter((server) => load(server) === least);
  return tied[Math.floor(random() * tied.length)] ?? tied[0];
}

/**
 * Where a computer starts next: back on the server that holds it while that server exists, or
 * the least-used server that still takes new computers.
 */
export function placeOnComputerServer(
  choice: ComputerServerChoice,
  random?: () => number,
): { server: ComputerServerRecord; ref?: string } | undefined {
  const { servers, current } = choice;
  if (current?.kind === SERVER_COMPUTER_KIND && current.providerRef) {
    const parsed = parseServerComputerRef(current.providerRef);
    const own = servers.find((server) => server.id === parsed?.serverId);
    if (own && parsed) return { server: own, ref: parsed.ref };
  }
  const server = pickComputerServer(servers, random);
  return server ? { server } : undefined;
}

export function addComputerServer(
  prisma: PrismaClient,
  input: {
    userId: string;
    name: string;
    sshHost: string;
    sshUser: string;
    maxComputers: number;
    secret: { id: string; ciphertext: string };
  },
): Promise<string> {
  return runAsSystem("add a computer server", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('computer-servers'))`);
      if ((await tx.computerServer.count()) >= MAX_COMPUTER_SERVERS)
        throw new ComputerServerLimitError();
      await tx.secret.create({
        data: {
          id: input.secret.id,
          userId: input.userId,
          kind: COMPUTER_SERVER_SECRET_KIND,
          ciphertext: input.secret.ciphertext,
        },
      });
      const server = await tx.computerServer.create({
        data: {
          name: input.name,
          sshHost: input.sshHost,
          sshUser: input.sshUser,
          maxComputers: input.maxComputers,
          secretId: input.secret.id,
          createdByUserId: input.userId,
        },
        select: { id: true },
      });
      return server.id;
    }),
  );
}

export function updateComputerServer(
  prisma: PrismaClient,
  input: {
    id: string;
    name?: string;
    maxComputers?: number;
    paused?: boolean;
    ready?: boolean;
    url?: string;
    sshUser?: string;
    setupState?: string | null;
    setupError?: string | null;
  },
): Promise<boolean> {
  return runAsSystem("change a computer server", async () => {
    const { id, ...data } = input;
    return (await prisma.computerServer.updateMany({ where: { id }, data })).count > 0;
  });
}

/** How long a setup may run before another one can take over from it. */
export const COMPUTER_SERVER_SETUP_LEASE_MS = 45 * 60_000;

/** Starts a setup unless one is already running; false when one is. */
export function claimComputerServerSetup(
  prisma: PrismaClient,
  id: string,
  now = new Date(),
): Promise<boolean> {
  return runAsSystem("start setting up a computer server", async () => {
    const stale = new Date(now.getTime() - COMPUTER_SERVER_SETUP_LEASE_MS);
    const claimed = await prisma.computerServer.updateMany({
      where: {
        id,
        OR: [
          { setupState: null },
          { setupState: { not: "installing" } },
          { setupStartedAt: null },
          { setupStartedAt: { lt: stale } },
        ],
      },
      data: { setupState: "installing", setupError: null, setupStartedAt: now },
    });
    return claimed.count > 0;
  });
}

/** Its computers start elsewhere next time, from their saved homes. */
export function removeComputerServer(
  prisma: PrismaClient,
  id: string,
): Promise<{ name: string } | null> {
  return runAsSystem("remove a computer server", () =>
    prisma.$transaction(async (tx) => {
      const server = await tx.computerServer.findUnique({
        where: { id },
        select: { name: true, secretId: true },
      });
      if (!server) return null;
      // The secret cascades to the server.
      await tx.secret.delete({ where: { id: server.secretId } });
      return { name: server.name };
    }),
  );
}
