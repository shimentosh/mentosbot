import * as z from "zod";

/** The user's own OAuth client and the account connected through it, in the current space. */
export const GoogleWorkspaceStateSchema = z.object({
  /** Where the provider sends the user back; the OAuth client must list it exactly. */
  redirectUri: z.string(),
  clientId: z.string().nullable(),
  account: z
    .object({
      email: z.string(),
      connectedAt: z.string(),
    })
    .nullable(),
});
export type GoogleWorkspaceState = z.infer<typeof GoogleWorkspaceStateSchema>;

export const GoogleWorkspaceClientInput = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(512),
});
export type GoogleWorkspaceClient = z.infer<typeof GoogleWorkspaceClientInput>;

export const GoogleWorkspaceCompleteInput = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(256),
});
