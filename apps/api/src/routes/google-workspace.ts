import {
  beginGoogleWorkspace,
  completeGoogleWorkspace,
  disconnectGoogleWorkspace,
  getGoogleWorkspace,
  saveGoogleWorkspaceClient,
} from "../google-workspace.js";
import type { RouterContext } from "./context.js";

export function googleWorkspaceRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    googleWorkspace: {
      get: authed.googleWorkspace.get.handler(({ context }) =>
        getGoogleWorkspace(deps, context.actor),
      ),
      saveClient: authed.googleWorkspace.saveClient.handler(({ context, input }) =>
        saveGoogleWorkspaceClient(deps, context.actor, input),
      ),
      begin: authed.googleWorkspace.begin.handler(({ context }) =>
        beginGoogleWorkspace(deps, context.actor),
      ),
      complete: authed.googleWorkspace.complete.handler(({ context, input }) =>
        completeGoogleWorkspace(deps, context.actor, input),
      ),
      disconnect: authed.googleWorkspace.disconnect.handler(({ context, input }) =>
        disconnectGoogleWorkspace(deps, context.actor, input),
      ),
    },
  };
}
