import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  DeploymentSettingsSchema,
  ObjectStorageSettingsSchema,
  ObjectStorageUpdateSchema,
  ObjectStorageUsageSchema,
  ServerUpdateCheckSchema,
  ServerUpdateRequestSchema,
  ServerUpdateRunSchema,
  ServerUpdateStatusSchema,
  StorageCleanupInputSchema,
  StorageCleanupResultSchema,
} from "./server-updates.js";

export const serverRpc = {
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  /** Admin choice of the bucket that holds bot homes and artifacts. */
  objectStorage: {
    get: oc.output(ObjectStorageSettingsSchema),
    update: oc.input(ObjectStorageUpdateSchema).output(ObjectStorageSettingsSchema),
    /** Measures the bucket the server is running on; null on local disk or while switching. */
    usage: oc.output(ObjectStorageUsageSchema.nullable()),
    /** What `cleanup` would remove; deployment admins only. */
    cleanupPreview: oc.input(StorageCleanupInputSchema).output(StorageCleanupResultSchema),
    /** Deletes every user's chat and bot files older than the cutoff; deployment admins only. */
    cleanup: oc.input(StorageCleanupInputSchema).output(StorageCleanupResultSchema),
  },
  /**
   * Deployment-owner product updates. When the Compose updater sidecar is reachable, these proxy
   * to its `/state` `/plan` `/apply` contract. Rollback stays on the sidecar for ops only and is
   * not exposed here. Never git-fetch from the API process.
   */
  updater: {
    status: oc.output(ServerUpdateStatusSchema),
    check: oc.input(ServerUpdateRequestSchema).output(ServerUpdateCheckSchema),
    apply: oc.input(ServerUpdateRequestSchema).output(ServerUpdateRunSchema),
  },
};
