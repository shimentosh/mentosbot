import { ORPCError } from "@orpc/server";
import { networkExitDescriptors, networkExitProvider } from "@rakazo/adapters";
import type { Actor, NetworkExitStatus } from "@rakazo/contracts";
import { Prisma, recordAuditEvent } from "@rakazo/db";
import { withSerializableRetry } from "../serializable-retry.js";
import type { RouterContext } from "./context.js";

export function networkExitRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  const status = async (actor: Actor): Promise<NetworkExitStatus> => {
    if (!deps.sandbox.describe().capabilities.networkExit)
      return { providers: [], connection: null };
    const connection = await deps.prisma.computerNetworkExit.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    return {
      providers: networkExitDescriptors(),
      connection: connection
        ? {
            provider: connection.provider,
            values: Object.fromEntries(
              Object.entries(connection.settings as Record<string, unknown>).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
            updatedAt: connection.updatedAt.toISOString(),
          }
        : null,
    };
  };

  return {
    networkExit: {
      get: authed.networkExit.get.handler(({ context }) => status(context.actor)),
      connect: authed.networkExit.connect.handler(async ({ context, input }) => {
        const { actor } = context;
        if (!deps.sandbox.describe().capabilities.networkExit) throw new ORPCError("NOT_FOUND");
        // Saving again without retyping a secret keeps the saved one.
        const saved = await deps.prisma.computerNetworkExit.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
          include: { secret: true },
        });
        const values = { ...input.values };
        if (saved?.provider === input.provider) {
          const credentials = JSON.parse(
            await deps.secrets.load(saved.secret.ciphertext, saved.secret.id),
          ) as Record<string, string>;
          for (const [key, value] of Object.entries(credentials))
            if (!values[key]?.trim()) values[key] = value;
        }
        let verified: ReturnType<ReturnType<typeof networkExitProvider>["verify"]>;
        try {
          verified = networkExitProvider(input.provider).verify(values);
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid network settings",
          });
        }
        const stored = await deps.secrets.put(JSON.stringify(verified.credentials), {
          operationId: "network-exit.connect",
          traceId: "network-exit.connect",
          spaceId: actor.spaceId,
          userId: actor.userId,
          signal: context.signal ?? new AbortController().signal,
        });
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const existing = await tx.computerNetworkExit.findUnique({
                where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
                select: { secretId: true },
              });
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  kind: "network-exit",
                  ciphertext: stored.ciphertext,
                },
              });
              const data = {
                provider: input.provider,
                settings: verified.settings,
                secretId: stored.id,
              };
              await tx.computerNetworkExit.upsert({
                where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
                create: { spaceId: actor.spaceId, userId: actor.userId, ...data },
                update: data,
              });
              if (existing) await tx.secret.deleteMany({ where: { id: existing.secretId } });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        await recordAuditEvent({
          action: "network_exit.connected",
          actor: { type: "user", id: actor.userId },
          spaceId: actor.spaceId,
          target: { type: "network_exit", label: input.provider },
        });
        return status(actor);
      }),
      disconnect: authed.networkExit.disconnect.handler(async ({ context }) => {
        const { actor } = context;
        const removed = await deps.prisma.$transaction(async (tx) => {
          const existing = await tx.computerNetworkExit.findUnique({
            where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
          });
          if (!existing) return null;
          await tx.computerNetworkExit.delete({ where: { id: existing.id } });
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
          return existing;
        });
        if (removed)
          await recordAuditEvent({
            action: "network_exit.disconnected",
            actor: { type: "user", id: actor.userId },
            spaceId: actor.spaceId,
            target: { type: "network_exit", label: removed.provider },
          });
        return status(actor);
      }),
    },
  };
}
