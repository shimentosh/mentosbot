import {
  getObjectStorageSettings,
  getObjectStorageUsage,
  updateObjectStorageSettings,
} from "../object-storage-config.js";
import { previewStorageCleanup, runStorageCleanup } from "../storage-cleanup.js";
import type { RouterContext } from "./context.js";

export function objectStorageRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    objectStorage: {
      get: authed.objectStorage.get.handler(({ context }) =>
        getObjectStorageSettings(deps, context.actor),
      ),
      update: authed.objectStorage.update.handler(({ context, input }) =>
        updateObjectStorageSettings(deps, context.actor, input),
      ),
      usage: authed.objectStorage.usage.handler(({ context }) =>
        getObjectStorageUsage(deps, context.actor),
      ),
      cleanupPreview: authed.objectStorage.cleanupPreview.handler(({ context, input }) =>
        previewStorageCleanup(deps, context.actor, input),
      ),
      cleanup: authed.objectStorage.cleanup.handler(({ context, input }) =>
        runStorageCleanup(deps, context.actor, input),
      ),
    },
  };
}
