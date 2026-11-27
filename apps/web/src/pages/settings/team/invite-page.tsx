import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAccessLevel, InvitableTeamRole, InvitationBotGrant } from "@rakazo/contracts";
import { Button, Field, FieldGroup, FieldLabel, Input, OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { useCopyText } from "../../../lib/copy-text";
import { queryClient, useQueryUserId } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import { BotAccessList } from "./bot-access-list";
import { grantableBotsQuery } from "./member-page";

/** Inviting someone by email, with the bots they get the moment they join. */
export function InvitePage({
  organizationId,
  canInviteAdmins,
  onInvited,
  onDone,
}: {
  organizationId: string;
  canInviteAdmins: boolean;
  onInvited: () => Promise<void>;
  /** Back to the team, once the invitation is on its way. */
  onDone: () => void;
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
        onDone();
        return;
      }
      setLink(invited.url);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  }

  if (link)
    return (
      <div className="flex flex-col gap-4" data-testid="team-invite">
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
        <Button className="self-start" onClick={onDone}>
          <Trans>Done</Trans>
        </Button>
      </div>
    );

  return (
    <form
      data-testid="team-invite"
      aria-label={t`Invite to team`}
      className="flex flex-col"
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
      {/* Stays in view at the bottom of the page while a long bot list scrolls. */}
      <div className="sticky bottom-0 -mx-6 mt-6 flex items-center gap-3 border-t border-border bg-dialog px-6 py-4 sm:-mx-8 sm:px-8">
        {error ? (
          <p role="alert" className="min-w-0 flex-1 text-body-sm text-destructive">
            {error}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <Button type="submit" disabled={pending || !email.trim()}>
          {pending ? <Trans>Inviting…</Trans> : <Trans>Invite</Trans>}
        </Button>
      </div>
    </form>
  );
}
