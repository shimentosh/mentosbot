import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { GOOGLE_WORKSPACE_CHANNEL } from "../lib/google-workspace-channel";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Where Google sends the sign-in back: finish it, tell the opener, and close. */
export function GoogleWorkspaceCallbackPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  const popup = window.name === GOOGLE_WORKSPACE_CHANNEL;
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(
        params.get("error") === "access_denied"
          ? t`Sign-in was cancelled.`
          : t`Google did not finish the sign-in.`,
      );
      return;
    }
    void rpc.googleWorkspace
      .complete({ code, state })
      .then(() => {
        const channel = new BroadcastChannel(GOOGLE_WORKSPACE_CHANNEL);
        channel.postMessage("connected");
        channel.close();
        if (popup) window.close();
        else navigate("/app", { replace: true });
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  }, [navigate, params, popup, t]);
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          {error ? <Trans>Google sign-in failed</Trans> : <Trans>Connecting Google…</Trans>}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p> : null}
        {error && !popup ? (
          <Button type="button" className="mt-5" onClick={() => navigate("/app")}>
            <Trans>Return to Rakazo</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
