import { Navigate, useParams } from "react-router-dom";
import { hasSignedInBefore } from "./returning-user";

const PENDING_INVITE_KEY = "rakazo:pending-invite";

/** Remembers an invitation opened signed out, so signing up or in comes back to it. */
export function rememberPendingInvite(invitationId: string) {
  try {
    window.sessionStorage.setItem(PENDING_INVITE_KEY, invitationId);
  } catch {
    // Without storage the person opens the link again after signing in.
  }
}

/** The invitation to return to after signing up or in; the invite page clears it. */
export function pendingInvitePath(): string | null {
  try {
    const id = window.sessionStorage.getItem(PENDING_INVITE_KEY);
    return id ? `/invite/${encodeURIComponent(id)}` : null;
  } catch {
    return null;
  }
}

export function clearPendingInvite() {
  try {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // Nothing was stored.
  }
}

/** Signed out: keep the invitation for after signing up or in. */
export function SignedOutInvite() {
  const { invitationId = "" } = useParams();
  rememberPendingInvite(invitationId);
  return <Navigate to={hasSignedInBefore() ? "/sign-in" : "/sign-up"} replace />;
}
