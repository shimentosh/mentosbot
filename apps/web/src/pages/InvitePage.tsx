import { Trans } from "@lingui/react/macro";
import { Button, buttonVariants } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { organizationsQuery } from "../lib/organizations";
import { clearPendingInvite } from "../lib/pending-invite";
import { queryClient, useQueryUserId } from "../lib/query";
import { rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

export function InvitePage() {
  const { invitationId = "" } = useParams();
  const userId = useQueryUserId();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(clearPendingInvite, []);
  const invitation = useQuery(
    {
      queryKey: [`user:${userId ?? ""}`, "invitation", invitationId],
      queryFn: () => rpc.team.invitation({ invitationId }),
      retry: false,
    },
    queryClient,
  );

  async function join() {
    setJoining(true);
    setError(null);
    try {
      const joined = await rpc.team.accept({ invitationId });
      await queryClient.invalidateQueries({ queryKey: organizationsQuery(userId).queryKey });
      selectSpace(joined.defaultSpaceId);
      window.location.assign("/app");
    } catch (reason) {
      setError(errorText(reason));
      setJoining(false);
    }
  }

  if (invitation.isPending) return <PageLoading />;
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="invite">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 pb-[90px] text-center">
        {invitation.data ? (
          <>
            <div className="space-y-2">
              <h1 className="text-2xl font-medium break-words text-foreground">
                <Trans>Join {invitation.data.organizationName}</Trans>
              </h1>
              {invitation.data.inviterName ? (
                <p className="text-[14px] text-muted-foreground">
                  <Trans>{invitation.data.inviterName} invited you.</Trans>
                </p>
              ) : null}
              <p className="text-[14px] text-muted-foreground">
                <Trans>The team's owner can see its chats and activity.</Trans>
              </p>
            </div>
            {error ? (
              <p role="alert" className="text-[13.5px] text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button disabled={joining} onClick={() => void join()}>
                {joining ? <Trans>Joining…</Trans> : <Trans>Join team</Trans>}
              </Button>
              <Link to="/app" className={buttonVariants({ variant: "ghost" })}>
                <Trans>Not now</Trans>
              </Link>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <h1 className="text-2xl font-medium text-foreground">
                <Trans>This invitation is no longer available</Trans>
              </h1>
              <p className="text-[14px] text-muted-foreground">
                <Trans>
                  It may have expired, or it was sent to another email address. Ask for a new one.
                </Trans>
              </p>
            </div>
            <Link to="/app" className={buttonVariants({ variant: "outline" })}>
              <Trans>Go home</Trans>
            </Link>
          </>
        )}
      </main>
    </div>
  );
}
