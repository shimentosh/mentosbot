import { Trans, useLingui } from "@lingui/react/macro";
import type { InvitableTeamRole, Team, TeamRole } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Copy, Ellipsis, UserPlus } from "lucide-react";
import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../../../components/settings/SettingsRows";
import { useCopyText } from "../../../lib/copy-text";
import { queryClient, useQueryUserId } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { organizationsQuery, useOrganizations } from "../../../lib/spaces/organizations";
import { InvitePage } from "./invite-page";
import { MemberPage } from "./member-page";
import { RoleName } from "./role-name";

function teamQuery(userId: string | null, organizationId: string) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "team", organizationId],
    queryFn: () => rpc.team.get({ organizationId }),
  });
}

type View = { kind: "list" } | { kind: "member"; userId: string } | { kind: "invite" };

/** The team of the organization the app is showing: its people, invitations, and their bots. */
export function TeamSettingsPanel() {
  const { organizations, activeOrganizationId } = useOrganizations();
  if (!activeOrganizationId || !organizations.some((org) => org.id === activeOrganizationId))
    return null;
  return <TeamSettings key={activeOrganizationId} organizationId={activeOrganizationId} />;
}

function TeamSettings({ organizationId }: { organizationId: string }) {
  const userId = useQueryUserId();
  const query = teamQuery(userId, organizationId);
  const { data: team } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const [view, setView] = useState<View>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);
  if (!team) return null;
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: query.queryKey }),
      queryClient.invalidateQueries({ queryKey: organizationsQuery(userId).queryKey }),
    ]);
  };
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const canInvite = team.role !== "member";
  const openMember =
    view.kind === "member" ? team.members.find((member) => member.userId === view.userId) : null;
  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="-ms-2 self-start text-muted-foreground"
      onClick={() => setView({ kind: "list" })}
    >
      <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
      <Trans>Team</Trans>
    </Button>
  );

  if (view.kind === "invite" && canInvite)
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h3 className="text-heading3 text-foreground">
          <Trans>Invite to team</Trans>
        </h3>
        <InvitePage
          organizationId={organizationId}
          canInviteAdmins={team.role === "owner"}
          onInvited={refresh}
          onDone={() => setView({ kind: "list" })}
        />
      </div>
    );
  if (openMember && canInvite)
    return (
      <div className="flex flex-col gap-4">
        {back}
        <MemberPage
          organizationId={organizationId}
          member={openMember}
          showUsage={team.role === "owner"}
        />
      </div>
    );

  return (
    <div className="flex max-w-2xl flex-col gap-6" data-testid="team-members">
      <SettingsGroup
        title={<Trans>Members</Trans>}
        action={
          canInvite ? (
            <Button variant="outline" size="sm" onClick={() => setView({ kind: "invite" })}>
              <UserPlus aria-hidden="true" />
              <Trans>Invite</Trans>
            </Button>
          ) : null
        }
      >
        {team.members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            viewerRole={team.role}
            isSelf={member.userId === userId}
            onOpen={
              canInvite ? () => setView({ kind: "member", userId: member.userId }) : undefined
            }
            onSetRole={(role) =>
              run(() => rpc.team.setRole({ organizationId, userId: member.userId, role }))
            }
            onRemove={async () => {
              await rpc.team.remove({ organizationId, userId: member.userId });
              if (member.userId === userId) {
                window.location.assign("/");
                return;
              }
              await refresh();
            }}
          />
        ))}
      </SettingsGroup>
      {team.invitations.length ? (
        <SettingsGroup title={<Trans>Invitations</Trans>}>
          {team.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onResend={() =>
                run(() =>
                  rpc.team.invite({
                    organizationId,
                    email: invitation.email,
                    role: invitation.role,
                  }),
                )
              }
              onRevoke={() => run(() => rpc.team.revokeInvitation({ invitationId: invitation.id }))}
            />
          ))}
        </SettingsGroup>
      ) : null}
      {error ? (
        <p role="alert" className="px-1 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function InvitationRow({
  invitation,
  onResend,
  onRevoke,
}: {
  invitation: Team["invitations"][number];
  onResend: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{invitation.email}</span>
          <span className="text-body-sm text-muted-foreground">
            <RoleName role={invitation.role} />
          </span>
        </span>
      }
      control={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Copy invite link for ${invitation.email}`}
            onClick={() => copy(invitation.url)}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Manage invite for ${invitation.email}`}
                />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void onResend()}>
                <Trans>Send a new link</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => void onRevoke()}>
                <Trans>Revoke</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}

/** Mirrors the server's rule: owners manage everyone else, admins manage members. */
function canManage(viewer: TeamRole, target: TeamRole): boolean {
  if (target === "owner") return false;
  return viewer === "owner" || (viewer === "admin" && target === "member");
}

function MemberRow({
  member,
  viewerRole,
  isSelf,
  onOpen,
  onSetRole,
  onRemove,
}: {
  member: Team["members"][number];
  viewerRole: TeamRole;
  isSelf: boolean;
  /** Opens the teammate's bots and usage; left out for oneself and for members. */
  onOpen?: () => void;
  onSetRole: (role: InvitableTeamRole) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const manageable = !isSelf && canManage(viewerRole, member.role);
  const canLeave = isSelf && member.role !== "owner";
  const shown = member.name.trim() || member.email;
  const name = (
    <span className="flex min-w-0 flex-col text-left">
      <span className="truncate">{shown}</span>
      {shown !== member.email ? (
        <span className="truncate text-body-sm text-muted-foreground">{member.email}</span>
      ) : null}
    </span>
  );
  return (
    <SettingsRow
      label={
        onOpen && !isSelf ? (
          <button
            type="button"
            className="-m-1 flex min-w-0 items-center gap-1 rounded-md p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t`Bots and usage for ${shown}`}
            onClick={onOpen}
          >
            {name}
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          name
        )
      }
      control={
        <>
          <span className="text-body-sm text-muted-foreground">
            <RoleName role={member.role} />
          </span>
          {manageable || canLeave ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label={t`Manage ${shown}`} />}
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {manageable && viewerRole === "owner" ? (
                  <DropdownMenuItem
                    onClick={() => void onSetRole(member.role === "admin" ? "member" : "admin")}
                  >
                    {member.role === "admin" ? (
                      <Trans>Make member</Trans>
                    ) : (
                      <Trans>Make admin</Trans>
                    )}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                  {isSelf ? <Trans>Leave team</Trans> : <Trans>Remove</Trans>}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {confirming ? (
            <RemoveDialog
              name={shown}
              leaving={isSelf}
              onCancel={() => setConfirming(false)}
              onConfirm={onRemove}
            />
          ) : null}
        </>
      }
    />
  );
}

function RemoveDialog({
  name,
  leaving,
  onCancel,
  onConfirm,
}: {
  name: string;
  leaving: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {leaving ? <Trans>Leave this team?</Trans> : <Trans>Remove {name}?</Trans>}
          </AlertDialogTitle>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(null);
              void onConfirm()
                .then(onCancel)
                .catch((reason: unknown) => {
                  setError(errorText(reason));
                  setPending(false);
                });
            }}
          >
            {leaving ? <Trans>Leave</Trans> : <Trans>Remove</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
