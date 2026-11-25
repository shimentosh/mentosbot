import * as z from "zod";
import { Id } from "../ids.js";

export const DeploymentSettingsSchema = z.object({
  ownerUserId: Id.nullable(),
  signupsEnabled: z.boolean(),
  signupAllowlist: z.array(z.string()),
  hasDeploymentModelCredential: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
  sandboxProvider: z.string(),
});

/** Where bot homes and artifacts are stored; secrets are never returned. */
export const ObjectStorageSettingsSchema = z.object({
  /** environment: OBJECT_STORAGE_* is set and wins; settings: saved here; none: local disk. */
  source: z.enum(["none", "environment", "settings"]),
  /** The running server uses this connection; false while it restarts onto a new one. */
  active: z.boolean(),
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  prefix: z.string(),
  pathStyle: z.boolean(),
  accessKeyId: z.string(),
  hasSecret: z.boolean(),
});
export type ObjectStorageSettings = z.infer<typeof ObjectStorageSettingsSchema>;
/** Space used in the running bucket; homes and artifacts are subsets of bytes. */
export const ObjectStorageUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
  homes: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  /** Counting stopped early; the totals are at least these. */
  partial: z.boolean(),
});
export type ObjectStorageUsage = z.infer<typeof ObjectStorageUsageSchema>;
/** Files whose whole family (every version) is older than this many days. */
export const StorageCleanupInputSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
});
export type StorageCleanupInput = z.infer<typeof StorageCleanupInputSchema>;
/** Files and bytes a cleanup would remove, or did. */
export const StorageCleanupResultSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type StorageCleanupResult = z.infer<typeof StorageCleanupResultSchema>;
export const ObjectStorageUpdateSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  bucket: z.string().trim().min(1).max(255),
  region: z.string().trim().max(64).default(""),
  prefix: z.string().trim().max(512).default(""),
  pathStyle: z.boolean().default(false),
  accessKeyId: z.string().trim().min(1).max(256),
  /** Blank keeps the saved secret, so an admin never has to see it again. */
  secretAccessKey: z.string().trim().max(512).default(""),
});
export type ObjectStorageUpdate = z.infer<typeof ObjectStorageUpdateSchema>;

export const ServerUpdateSourceSchema = z.object({
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  official: z.boolean(),
});

export const ServerUpdateStepSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(8_001),
});

/** How an update reaches new code: published images, a build on the server, or a git checkout. */
export const ServerUpdateStrategySchema = z.enum(["pull", "build", "checkout"]);

/** `sidecar` is the Compose deployment; `checkout` is a supervised source install. */
export const ServerUpdateModeSchema = z.enum(["sidecar", "checkout", "unavailable"]);

/**
 * What Settings should render for a deployment owner.
 * `sidecar`: Check / Update / Rollback through the updater sidecar.
 * `compose`: Compose install without a reachable sidecar; show host pull/up commands.
 * `source`: git checkout / `pnpm dev`; show terminal commands, never a fake Apply.
 */
export const ServerUpdateInstallKindSchema = z.enum(["sidecar", "compose", "source"]);

export const ServerUpdateRunSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  ok: z.boolean(),
  fromCommit: z.string().nullable(),
  toCommit: z.string().nullable(),
  fromTag: z.string().nullable(),
  toTag: z.string().nullable(),
  strategy: ServerUpdateStrategySchema.nullable(),
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  /**
   * `recreated` means the updater sidecar replaced the containers and no restart is owed.
   * `supervised` means the process exited and its supervisor is bringing it back.
   */
  restart: z.enum(["recreated", "supervised", "manual", "not-required"]),
  restartAdvice: z.string(),
  error: z.string().nullable(),
  steps: z.array(ServerUpdateStepSchema),
});
export type ServerUpdateRun = z.infer<typeof ServerUpdateRunSchema>;

export const ServerUpdateStatusSchema = z.object({
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  installKind: ServerUpdateInstallKindSchema,
  /** Host commands to run when `installKind` is not `sidecar`. Empty when the sidecar applies. */
  manualCommands: z.array(z.string()),
  mode: ServerUpdateModeSchema,
  strategy: ServerUpdateStrategySchema.nullable(),
  strategyNote: z.string().nullable(),
  version: z.string(),
  revision: z.string().nullable(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  dirty: z.boolean(),
  dirtyPaths: z.array(z.string()),
  image: z.string().nullable(),
  imageTag: z.string().nullable(),
  previousImageTag: z.string().nullable(),
  canRollback: z.boolean(),
  source: ServerUpdateSourceSchema,
  officialRepoUrl: z.string(),
  restartSupervisor: z.enum(["systemd", "pm2", "declared", "none"]),
  restartAdvice: z.string(),
  running: z.boolean(),
  lastRun: ServerUpdateRunSchema.nullable(),
});

export const ServerUpdateCheckSchema = z.object({
  status: z.enum(["unavailable", "dirty", "up-to-date", "available"]),
  reason: z.string().nullable(),
  changed: z.array(z.string()),
  commit: z.string().nullable(),
  targetCommit: z.string().nullable(),
  targetTag: z.string().nullable(),
  behindBy: z.number().int().nonnegative(),
});

export const ServerUpdateRequestSchema = z.object({
  repoUrl: z.string().max(400).optional(),
  branch: z.string().max(200).optional(),
});
