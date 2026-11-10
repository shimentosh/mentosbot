import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { CircleUserRound } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { addAccountPath } from "../lib/add-account";
import { authClient } from "../lib/auth";
import { switchOrganization, useOrganizations } from "../lib/organizations";
import { useQueryUserId } from "../lib/query";
import { switchAccount, useSignedInAccounts } from "../lib/signed-in-accounts";
import { DeleteAccountForm, hasDeleteRedirectError } from "./AccountAccess";

/**
 * The way out before the app opens (plan choice, onboarding): switch or add an account, log out
 * or delete the account, without reaching settings.
 */
export function AccountMenu({
  disabled,
  signingOut,
  onLogOut,
}: {
  disabled?: boolean;
  signingOut: boolean;
  onLogOut: () => void;
}) {
  const { t } = useLingui();
  const email = authClient.useSession().data?.user.email;
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  const signedIn = useSignedInAccounts();
  const navigate = useNavigate();
  // An SSO sign-in to confirm deletion returns here; reopen so its error is seen.
  const [deleting, setDeleting] = useState(hasDeleteRedirectError);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Account`}
          data-testid="account-menu"
          disabled={disabled || signingOut}
          render={
            <Button
              variant="ghost"
              size="icon"
              className="fixed top-4 right-6 text-muted-foreground"
            />
          }
        >
          <CircleUserRound />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {email ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{email}</DropdownMenuLabel>
                {signedIn.others.map((account) => (
                  <DropdownMenuItem
                    key={account.userId}
                    onClick={() => void switchAccount(account.userId)}
                  >
                    <span className="min-w-0 truncate">{account.email}</span>
                  </DropdownMenuItem>
                ))}
                {signedIn.canAdd && userId ? (
                  <DropdownMenuItem onClick={() => navigate(addAccountPath(userId))}>
                    <Trans>Add account</Trans>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {organizations.length > 1 ? (
            <>
              <DropdownMenuRadioGroup
                value={activeOrganizationId}
                onValueChange={(id) => {
                  const organization = organizations.find((candidate) => candidate.id === id);
                  if (organization && id !== activeOrganizationId)
                    void switchOrganization(userId, organization);
                }}
              >
                {organizations.map((organization) => (
                  <DropdownMenuRadioItem key={organization.id} value={organization.id}>
                    <span className="min-w-0 truncate">{organization.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onClick={onLogOut}>
            <Trans>Log out</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDeleting(true)}>
            <Trans>Delete account</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete account</Trans>
            </DialogTitle>
          </DialogHeader>
          <DeleteAccountForm open />
        </DialogContent>
      </Dialog>
    </>
  );
}
