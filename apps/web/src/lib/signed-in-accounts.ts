import type { SignedInAccount } from "@rakazo/contracts";
import { MAX_SIGNED_IN_ACCOUNTS, signedInAccountsSchema } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "./auth";
import { fetchAuthCapabilities } from "./auth-capabilities";
import { endCallBeforeSignOut, forgetSignedInUser, sessionChangedUnderPage } from "./call-session";
import { queryClient, useQueryUserId } from "./query";
import { clearSpaceSelection } from "./rpc";

export type { SignedInAccount } from "@rakazo/contracts";

/**
 * The other accounts this browser is signed in to, and whether it may add one. Empty on a
 * deployment for one person.
 */
export function useSignedInAccounts(): { others: SignedInAccount[]; canAdd: boolean } {
  const userId = useQueryUserId();
  const { data } = useQuery(
    {
      queryKey: [`user:${userId ?? ""}`, "signed-in-accounts"],
      enabled: Boolean(userId),
      queryFn: async () => {
        if (!(await fetchAuthCapabilities()).multipleAccounts) return null;
        const { data, error } = await authClient.$fetch<unknown>("/signed-in-accounts");
        if (error) throw error;
        return signedInAccountsSchema.parse(data).accounts;
      },
    },
    queryClient,
  );
  if (!data) return { others: [], canAdd: false };
  return {
    others: data.filter((account) => !account.active),
    canAdd: data.length < MAX_SIGNED_IN_ACCOUNTS,
  };
}

/**
 * Moves the browser to another account it holds, then loads a fresh page, so no call, stream or
 * cached answer of the account being left survives. Other tabs reload onto the new account.
 */
export async function switchAccount(userId: string): Promise<void> {
  // Hang up while the session still exists, so the server-side hang-up is authorized.
  await endCallBeforeSignOut();
  const switched =
    !sessionChangedUnderPage() &&
    !(
      await authClient
        .$fetch("/signed-in-accounts/switch", { method: "POST", body: { userId } })
        .catch((error: unknown) => ({ error }))
    ).error;
  // A failed switch (its session ended elsewhere) reloads too; the fresh list leaves it out.
  if (!switched) {
    window.location.reload();
    return;
  }
  forgetSignedInUser();
  // Spaces belong to the account being left; the next one opens where it was last.
  clearSpaceSelection();
  window.location.assign("/app");
}
