import { Trans } from "@lingui/react/macro";
import type { TeamRole } from "@rakazo/contracts";

export function RoleName({ role }: { role: TeamRole }) {
  if (role === "owner") return <Trans>Owner</Trans>;
  if (role === "admin") return <Trans>Admin</Trans>;
  return <Trans>Member</Trans>;
}
