import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotAccessLevel,
  InvitableTeamRole,
  InvitationBotGrant,
  Team,
  TeamRole,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
} from "@rakazo/ui-web";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Ellipsis, UserPlus } from "lucide-react";
import { useId, useState } from "react";
import { SettingsGroup, SettingsRow } from "../../../components/settings/SettingsRows";
import { useCopyText } from "../../../lib/copy-text";
import { queryClient, useQueryUserId } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { organizationsQuery } from "../../../lib/spaces/organizations";
import { BotAccessList } from "./bot-access-list";
import { grantableBotsQuery, MemberDialog } from "./member-dialog";

function teamQuery(userId: string | null, organizationId: string) {
  return queryOptions({
    queryKey: [`user:${userId ?? ""}`, "team", organizationId],
    queryFn: () => rpc.team.get({ organizationId }),
  });
}

/** Who is on the team, and for owners and admins, inviting and managing them. */
export function TeamMembersSettings({ organizationId }: { organizationId: string }) {
  const userId = useQueryUserId();
  const query = teamQuery(userId, organizationId);
  const { data: team } = useQuery({ ...query, enabled: Boolean(userId) }, queryClient);
  const [inviting, setInviting] = useState(false);
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!team) return null;
  const openMember = team.members.find((member) => member.userId === openMemberId);
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
  return (
    <div className="space-y-6" data-testid="team-members">
      <SettingsGroup
        title={<Trans>Members</Trans>}
        action={
          canInvite ? (
            <Button variant="outline" size="sm" onClick={() => setInviting(true)}>
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
            onOpen={canInvite ? () => setOpenMemberId(member.userId) : undefined}
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
      {openMember ? (
        <MemberDialog
          organizationId={organizationId}
          member={openMember}
          showUsage={team.role === "owner"}
          onClose={() => setOpenMemberId(null)}
        />
      ) : null}
      {inviting ? (
        <InviteDialog
          organizationId={organizationId}
          canInviteAdmins={team.role === "owner"}
          onInvited={refresh}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </div>
  );
}

function RoleName({ role }: { role: TeamRole }) {
  if (role === "owner") return <Trans>Owner</Trans>;
  if (role === "admin") return <Trans>Admin</Trans>;
  return <Trans>Member</Trans>;
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

function InviteDialog({
  organizationId,
  canInviteAdmins,
  onInvited,
  onClose,
}: {
  organizationId: string;
  canInviteAdmins: boolean;
  onInvited: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableTeamRole>("member");
  const userId = useQueryUserId();
  const { data: bots = [] } = useQuery(
    { ...grantableBotsQuery(userId, organizationId), enabled: Boolean(userId) },
    queryClient,
  );
  const [grants, setGrants] = useState<ReadonlyMap<string, BotAccessLevel>>(new Map());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Without email delivery the inviter passes the link on themselves.
  const [link, setLink] = useState<string | null>(null);
  const [copied, copy] = useCopyText();

  async function submit() {
    if (pending || !email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const picked: InvitationBotGrant[] = [...grants].map(([botId, level]) => ({ botId, level }));
      const invited = await rpc.team.invite({
        organizationId,
        email: email.trim(),
        role,
        bots: picked,
      });
      await onInvited();
      if (invited.emailSent) {
        onClose();
        return;
      }
      setLink(invited.url);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  }

  const formId = useId();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader className="px-6 pt-6 pe-14 pb-4">
          <DialogTitle>
            <Trans>Invite to team</Trans>
          </DialogTitle>
        </DialogHeader>
        {link ? (
          <div className="px-6 pb-6">
            <Field>
              <FieldLabel>
                <Trans>Send this link to {email}</Trans>
              </FieldLabel>
              <div className="flex gap-2">
                <Input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t`Copy link`}
                  onClick={() => copy(link)}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            </Field>
          </div>
        ) : (
          <>
            <form
              id={formId}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <Field>
                    <FieldLabel htmlFor={emailId}>
                      <Trans>Email</Trans>
                    </FieldLabel>
                    <Input
                      id={emailId}
                      type="email"
                      autoComplete="off"
                      value={email}
                      disabled={pending}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setError(null);
                      }}
                    />
                  </Field>
                  {canInviteAdmins ? (
                    <Field>
                      <FieldLabel htmlFor={roleId}>
                        <Trans>Role</Trans>
                      </FieldLabel>
                      <OptionSelect<InvitableTeamRole>
                        id={roleId}
                        value={role}
                        disabled={pending}
                        onValueChange={setRole}
                        options={[
                          { value: "member", label: t`Member` },
                          { value: "admin", label: t`Admin` },
                        ]}
                      />
                    </Field>
                  ) : null}
                </div>
                {bots.length ? (
                  <Field>
                    <FieldLabel>
                      <Trans>Bots</Trans>
                    </FieldLabel>
                    <BotAccessList
                      bots={bots}
                      levelOf={(botId) => grants.get(botId) ?? null}
                      personName={email.trim() || t`They`}
                      disabled={pending}
                      onChange={(changes) =>
                        setGrants((now) => {
                          const next = new Map(now);
                          for (const { botId, level } of changes) {
                            if (level) next.set(botId, level);
                            else next.delete(botId);
                          }
                          return next;
                        })
                      }
                    />
                  </Field>
                ) : null}
              </FieldGroup>
            </form>
            <div className="flex items-center gap-3 border-t border-border px-6 py-4">
              {error ? (
                <p role="alert" className="min-w-0 flex-1 text-body-sm text-destructive">
                  {error}
                </p>
              ) : (
                <span className="flex-1" />
              )}
              <Button type="submit" form={formId} disabled={pending || !email.trim()}>
                {pending ? <Trans>Inviting…</Trans> : <Trans>Invite</Trans>}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
