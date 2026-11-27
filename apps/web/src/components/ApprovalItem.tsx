import { Trans, useLingui } from "@lingui/react/macro";
import type { Approval, LoginFieldInput } from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { approvalsQueryKey } from "../lib/inbox";
import { formatRelativeTime } from "../lib/locale/relative-time";
import { queryClient, useQueryUserId, useSave } from "../lib/query/query";
import { rpc, rpcForSpace, selectedSpaceId } from "../lib/query/rpc";
import { SpaceRpcProvider } from "../lib/query/space-rpc";
import { errorText } from "../lib/query/user-error";
import { ArtifactImage } from "../pages/shell/chat/message-cards";
import { AskCard } from "./messages/AskCard";

/** How long an answered card stays to show its outcome before the list drops it. */
export const ANSWERED_LINGER_MS = 900;

/** Every card waiting on the person across their organization, refreshed while shown. */
export function useApprovals() {
  const userId = useQueryUserId();
  const spaceId = selectedSpaceId();
  return useQuery(
    {
      queryKey: [...approvalsQueryKey(userId), spaceId ?? ""],
      queryFn: () => rpc.inbox.approvals(),
      enabled: Boolean(userId),
      refetchInterval: (query) =>
        query.state.error && !isRetryableError(query.state.error) ? false : 10_000,
    },
    queryClient,
  );
}

export function chatPath(approval: Approval): string {
  return approval.groupId ? `/app/g/${approval.groupId}` : `/app/${approval.bot.id}`;
}

export function answerApproval(
  approval: Approval,
  messageId: string,
  answer: string,
  fields?: LoginFieldInput[],
  remember?: false,
  dismiss?: boolean,
) {
  return rpcForSpace(approval.spaceId).threads.answer({
    ...(approval.groupId ? { groupId: approval.groupId } : { botId: approval.bot.id }),
    runId: approval.runId,
    messageId,
    answer,
    ...(fields ? { fields } : {}),
    ...(remember === false ? { remember } : {}),
    ...(dismiss ? { dismiss: true as const } : {}),
  });
}

type ApprovalItemProps = {
  approval: Approval;
  showSpace: boolean;
  onAnswered: () => void;
  onOpen: () => void;
};

export function ApprovalItem(props: ApprovalItemProps) {
  // Cancelling goes to the card's own space, which may not be the one open.
  return (
    <SpaceRpcProvider spaceId={props.approval.spaceId}>
      <ApprovalRow {...props} />
    </SpaceRpcProvider>
  );
}

function ApprovalRow({ approval, showSpace, onAnswered, onOpen }: ApprovalItemProps) {
  const { t } = useLingui();
  const { ask, bot } = approval;
  const target = approval.groupId ? { groupId: approval.groupId } : { botId: bot.id };
  // Stops the run waiting on the person, as Stop does in the chat.
  const cancel = useSave({
    save: (_: undefined, client) => client.threads.stop(target),
    onSaved: onAnswered,
    closesScreen: true,
  });
  return (
    <li className="flex min-w-0 gap-3" data-testid="approval">
      <BotAvatar identity={bot.id} color={bot.color} avatarSet={bot.avatarSet} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium text-foreground">{bot.name}</span>
          <span className="shrink-0 text-body-sm text-muted-foreground">
            {showSpace
              ? `${approval.spaceName} · ${formatRelativeTime(approval.at)}`
              : formatRelativeTime(approval.at)}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ms-auto shrink-0 text-muted-foreground"
            onClick={onOpen}
          >
            <Trans>Open chat</Trans>
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
        {ask?.block.kind === "ask" ? (
          <AskCard
            block={ask.block}
            canAnswer
            canDismiss
            rpc={rpcForSpace(approval.spaceId)}
            onAnswer={async (text, fields, remember) => {
              await answerApproval(approval, ask.messageId, text, fields, remember);
              onAnswered();
            }}
            onDismiss={async () => {
              await answerApproval(approval, ask.messageId, "", undefined, undefined, true);
              onAnswered();
            }}
            onCancel={async () => {
              await rpcForSpace(approval.spaceId).threads.stop(target);
              onAnswered();
            }}
            renderImage={
              showSpace
                ? undefined
                : (image) => (
                    <ArtifactImage
                      target={target}
                      artifactId={image.artifactId}
                      name={image.name}
                    />
                  )
            }
          />
        ) : (
          <div className="flex flex-col gap-2 rounded-[20px] bg-muted px-5 py-4 text-body text-foreground">
            <div className="flex items-center gap-3">
              <span className="flex-1">{t`Needs you in the chat`}</span>
              <Button
                variant="text"
                size="sm"
                disabled={cancel.pending}
                onClick={() => cancel.run(undefined)}
              >
                {cancel.pending ? <Trans>Cancelling…</Trans> : <Trans>Cancel</Trans>}
              </Button>
              <Button size="sm" onClick={onOpen}>
                <Trans>Open</Trans>
              </Button>
            </div>
            {cancel.error ? (
              <p role="alert" className="text-body-sm text-destructive">
                {errorText(cancel.error, t`Could not cancel`)}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}
