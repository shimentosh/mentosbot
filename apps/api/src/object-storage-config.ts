import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type {
  ObjectStorageConnection,
  ResolvedObjectStorage,
  ResolveHostname,
} from "@rakazo/adapters";
import {
  assertSafeWebUrl,
  DEPLOYMENT_OBJECT_STORAGE_RECORD,
  loadSavedObjectStorage,
  measureObjectStorage,
  objectStorageConfigFromEnv,
  objectStorageFingerprint,
  verifyObjectStorage,
} from "@rakazo/adapters";
import type {
  Actor,
  ObjectStorageSettings,
  ObjectStorageUpdate,
  ObjectStorageUsage,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";
import { withSerializableRetry } from "./serializable-retry.js";

export interface ObjectStorageConfigDeps {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load" | "delete">;
  env: Pick<RouterDeps["env"], "adminEmails">;
  /** The connection this API process started with; absent means local disk. */
  objectStorage?: ResolvedObjectStorage;
  resolveHostname?: ResolveHostname;
  /** Test seam: confirm the bucket accepts a write before saving. */
  verify?: (config: ObjectStorageConnection) => Promise<void>;
  /** Test seam: add up the bucket's objects. */
  measure?: (config: ObjectStorageConnection) => Promise<ObjectStorageUsage>;
  /** Process environment; a test seam for OBJECT_STORAGE_*. */
  processEnv?: NodeJS.ProcessEnv;
}

const VERIFY_TIMEOUT_MS = 20_000;

function view(
  source: ObjectStorageSettings["source"],
  config: ObjectStorageConnection | undefined,
  running: ResolvedObjectStorage | undefined,
): ObjectStorageSettings {
  return {
    source,
    active: objectStorageFingerprint(config) === objectStorageFingerprint(running?.config),
    endpoint: config?.endpoint ?? "",
    bucket: config?.bucket ?? "",
    region: config?.region ?? "",
    prefix: config?.prefix.replace(/\/$/, "") ?? "",
    pathStyle: config?.pathStyle ?? false,
    accessKeyId: config?.accessKeyId ?? "",
    hasSecret: Boolean(config?.secretAccessKey),
  };
}

export async function getObjectStorageSettings(
  deps: ObjectStorageConfigDeps,
  actor: Actor,
): Promise<ObjectStorageSettings> {
  await requireAdmin(deps, actor.userId);
  const fromEnv = objectStorageConfigFromEnv(deps.processEnv ?? process.env);
  if (fromEnv) return view("environment", fromEnv, deps.objectStorage);
  const saved = await loadSavedObjectStorage(deps.prisma, deps.secrets);
  return view(saved ? "settings" : "none", saved, deps.objectStorage);
}

/** Space used in the bucket this server runs on; none on local disk. */
export async function getObjectStorageUsage(
  deps: ObjectStorageConfigDeps,
  actor: Actor,
): Promise<ObjectStorageUsage | null> {
  await requireAdmin(deps, actor.userId);
  if (!deps.objectStorage) return null;
  try {
    return await (deps.measure ?? measureObjectStorage)(deps.objectStorage.config);
  } catch (error) {
    // Storage errors can echo the endpoint or key: log only the error's class.
    getLogger().warn("object_storage.measure_failed", {
      "user.id": actor.userId,
      "error.name": error instanceof Error ? error.name : typeof error,
    });
    throw new ORPCError("BAD_GATEWAY", { message: "Could not read this bucket" });
  }
}

/**
 * Saves a bucket for homes and artifacts once it accepts a write. API and worker restart onto it
 * (see watchObjectStorageSettings). Stored homes name objects in that bucket, so once saved only
 * its credentials, region and addressing can change; the bucket, endpoint and prefix cannot.
 */
export async function updateObjectStorageSettings(
  deps: ObjectStorageConfigDeps,
  actor: Actor,
  input: ObjectStorageUpdate,
): Promise<ObjectStorageSettings> {
  await requireAdmin(deps, actor.userId);
  if (objectStorageConfigFromEnv(deps.processEnv ?? process.env))
    throw new ORPCError("BAD_REQUEST", { message: "Storage is set by the server environment" });
  const saved = await loadSavedObjectStorage(deps.prisma, deps.secrets);
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  const config: ObjectStorageConnection = {
    bucket: input.bucket,
    endpoint: input.endpoint,
    region: input.region || "us-east-1",
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey || saved?.secretAccessKey || "",
    prefix: prefix ? `${prefix}/` : "",
    pathStyle: input.pathStyle,
  };
  if (
    saved &&
    (saved.bucket !== config.bucket ||
      saved.endpoint !== config.endpoint ||
      saved.prefix !== config.prefix)
  )
    throw new ORPCError("BAD_REQUEST", { message: "Saved files are in this bucket" });
  if (!config.secretAccessKey)
    throw new ORPCError("BAD_REQUEST", { message: "Enter the secret access key" });
  try {
    const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
    await assertSafeWebUrl(input.endpoint, deps.resolveHostname, signal);
    const verify = deps.verify ?? verifyObjectStorage;
    await Promise.race([
      verify(config),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  } catch (error) {
    // Storage errors can echo the endpoint or key: log only the error's class.
    getLogger().warn("object_storage.verify_failed", {
      "user.id": actor.userId,
      "error.name": error instanceof Error ? error.name : typeof error,
    });
    throw new ORPCError("BAD_REQUEST", { message: "Could not write to this bucket" });
  }
  // Owned by the deployment row, so no account deletion removes it.
  const stored = await deps.secrets.put(
    JSON.stringify(config),
    {
      operationId: "object-storage-config",
      traceId: "object-storage-config",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
    { recordId: DEPLOYMENT_OBJECT_STORAGE_RECORD },
  );
  const forget = (ciphertext: string) =>
    deps.secrets.delete(ciphertext, DEPLOYMENT_OBJECT_STORAGE_RECORD).catch(() => undefined);
  let replaced: string | null | undefined;
  try {
    replaced = await withSerializableRetry(() =>
      runAsSystem("an admin configures object storage", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { objectStorageCipher: true },
            });
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: { id: "default", objectStorageCipher: stored.ciphertext },
              update: { objectStorageCipher: stored.ciphertext },
            });
            return current?.objectStorageCipher;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await forget(stored.ciphertext);
    throw error;
  }
  if (replaced && replaced !== stored.ciphertext) await forget(replaced);
  return view("settings", config, deps.objectStorage);
}
