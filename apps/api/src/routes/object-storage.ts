import { getObjectStorageSettings, updateObjectStorageSettings } from "../object-storage-config.js";
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
    },
  };
}
