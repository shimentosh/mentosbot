import { createHash, randomUUID } from "node:crypto";
import type { ObjectStorage, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { S3ObjectStorageConfig } from "./s3-object-storage.js";
import { objectStorageConfigFromEnv, S3ObjectStorage } from "./s3-object-storage.js";

export type { S3ObjectStorageConfig };
/** A bucket connection, named for callers outside the adapter layer. */
export type ObjectStorageConnection = S3ObjectStorageConfig;
export { objectStorageConfigFromEnv };

/** Secret record that owns the saved connection: the deployment row, not a user or space. */
export const DEPLOYMENT_OBJECT_STORAGE_RECORD = "deployment-object-storage";

/** Where the running object storage connection came from. */
export type ObjectStorageSource = "environment" | "settings";

export interface ResolvedObjectStorage {
  config: S3ObjectStorageConfig;
  source: ObjectStorageSource;
}

/** How often API and worker look for a connection saved in Settings. */
const WATCH_INTERVAL_MS = 15_000;
const PROBE_PREFIX = "rakazo-connection-check/";

/** Reads a connection saved in Settings; one that no longer decrypts or parses counts as none. */
export async function loadSavedObjectStorage(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): Promise<S3ObjectStorageConfig | undefined> {
  const row = await runAsSystem("read the deployment's object storage", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { objectStorageCipher: true },
    }),
  );
  if (!row?.objectStorageCipher) return undefined;
  try {
    return parseObjectStorageConfig(
      await secrets.load(row.objectStorageCipher, DEPLOYMENT_OBJECT_STORAGE_RECORD),
    );
  } catch (error) {
    getLogger().error("object storage settings unreadable", error);
    return undefined;
  }
}

/**
 * The connection this process stores homes and artifacts in. `OBJECT_STORAGE_*` wins, so an
 * operator's environment is never overridden from the app; otherwise the one saved in Settings.
 */
export async function resolveObjectStorage(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedObjectStorage | undefined> {
  const fromEnv = objectStorageConfigFromEnv(env);
  if (fromEnv) return { config: fromEnv, source: "environment" };
  const saved = await loadSavedObjectStorage(prisma, secrets);
  return saved ? { config: saved, source: "settings" } : undefined;
}

/** Changes whenever any part of the connection does, credentials included; reveals none of it. */
export function objectStorageFingerprint(config: S3ObjectStorageConfig | undefined): string {
  if (!config) return "none";
  return createHash("sha256")
    .update(JSON.stringify(normalized(config)))
    .digest("hex");
}

/**
 * Writes, reads back and deletes one small object, so a connection is saved only once it works.
 * The probe key carries the configured prefix like every other object.
 */
export async function verifyObjectStorage(
  config: S3ObjectStorageConfig,
  storage: ObjectStorage = new S3ObjectStorage(config),
): Promise<void> {
  const key = `${PROBE_PREFIX}${randomUUID()}`;
  const body = new TextEncoder().encode("ok");
  await storage.put(
    key,
    (async function* () {
      yield body;
    })(),
  );
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of storage.get(key)) chunks.push(chunk);
    if (Buffer.concat(chunks).toString() !== "ok")
      throw new Error("Object storage returned different content");
  } finally {
    await storage.delete([key]);
  }
}

/** Bytes and objects in a bucket, under its prefix, by what they hold. */
export interface ObjectStorageUsage {
  bytes: number;
  objects: number;
  /** Bot homes. */
  homes: number;
  /** Files in chats. */
  artifacts: number;
  /** Counting stopped at the limit, so the totals are a lower bound. */
  partial: boolean;
}

/** Enough for any deployment the settings panel serves without listing for minutes. */
const MEASURE_LIMIT = 250_000;

/** Lists every object once and adds up its size; listing is the only portable way to measure. */
export async function measureObjectStorage(
  config: S3ObjectStorageConfig,
  storage: ObjectStorage = new S3ObjectStorage(config),
  limit = MEASURE_LIMIT,
): Promise<ObjectStorageUsage> {
  const usage: ObjectStorageUsage = {
    bytes: 0,
    objects: 0,
    homes: 0,
    artifacts: 0,
    partial: false,
  };
  for await (const object of storage.list("")) {
    if (usage.objects >= limit) {
      usage.partial = true;
      break;
    }
    usage.objects += 1;
    usage.bytes += object.size;
    if (object.key.startsWith("homes/")) usage.homes += object.size;
    else if (object.key.startsWith("artifacts/")) usage.artifacts += object.size;
  }
  return usage;
}

/**
 * Calls `onChange` once when the connection saved in Settings no longer matches the one this
 * process started with. Homes and artifacts pick their store at startup, so the caller restarts:
 * the same switch an operator makes by setting `OBJECT_STORAGE_BUCKET` and restarting.
 * An environment connection is never replaced, so there is nothing to watch.
 */
export function watchObjectStorageSettings(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  started: ResolvedObjectStorage | undefined,
  onChange: () => void,
  intervalMs = WATCH_INTERVAL_MS,
): () => void {
  if (started?.source === "environment") return () => {};
  const startedWith = objectStorageFingerprint(started?.config);
  let stopped = false;
  const timer = setInterval(() => {
    void loadSavedObjectStorage(prisma, secrets)
      .then((saved) => {
        if (stopped || objectStorageFingerprint(saved) === startedWith) return;
        stopped = true;
        clearInterval(timer);
        getLogger().info("object_storage.settings_changed");
        onChange();
      })
      .catch((error) => getLogger().error("object storage settings check", error));
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function parseObjectStorageConfig(plaintext: string): S3ObjectStorageConfig | undefined {
  const value = JSON.parse(plaintext) as Partial<S3ObjectStorageConfig>;
  if (
    typeof value.bucket !== "string" ||
    !value.bucket ||
    typeof value.accessKeyId !== "string" ||
    !value.accessKeyId ||
    typeof value.secretAccessKey !== "string" ||
    !value.secretAccessKey ||
    typeof value.region !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.pathStyle !== "boolean" ||
    (value.endpoint !== undefined && typeof value.endpoint !== "string")
  )
    return undefined;
  return normalized(value as S3ObjectStorageConfig);
}

function normalized(config: S3ObjectStorageConfig): S3ObjectStorageConfig {
  return {
    bucket: config.bucket,
    endpoint: config.endpoint || undefined,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    prefix: config.prefix,
    pathStyle: config.pathStyle,
  };
}

/** How long a graceful stop may take before the process exits anyway. */
const RESTART_GRACE_MS = 30_000;

/**
 * Stops this process through its normal shutdown so the service manager starts it again on the
 * new connection. The published Compose files restart API and worker on exit.
 */
export function restartOntoSavedObjectStorage(): void {
  getLogger().info("object_storage.restarting");
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(0), RESTART_GRACE_MS).unref();
}
