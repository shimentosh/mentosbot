import type { Approval } from "@rakazo/contracts";
import { ANSWERED_LINGER_MS, ApprovalItem, useApprovals } from "../../components/ApprovalItem";
import { inboxQueryKey } from "../../lib/inbox";
import { queryClient, useQueryUserId } from "../../lib/query";

/**
 * Cards that bots this bot handed work to are waiting on, answerable in this chat: the person
 * talks to the bot that delegated, not to the bot that asks.
 */
export function DelegatedCards({
  botId,
  onOpen,
}: {
  botId: string;
  onOpen: (approval: Approval) => void;
}) {
  const userId = useQueryUserId();
  const approvals = useApprovals().data ?? [];
  const cards = approvals.filter(
    (approval) => approval.requestedByBotId === botId && approval.ask !== null,
  );
  if (cards.length === 0) return null;
  const refreshSoon = () =>
    window.setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: inboxQueryKey(userId) }),
      ANSWERED_LINGER_MS,
    );
  return (
    <ul
      className="pointer-events-auto flex max-h-[45vh] flex-col gap-4 overflow-y-auto bg-background px-3 pb-3 pt-7 md:px-[max(1.5rem,calc((100%_-_60rem)/2))]"
      data-testid="delegated-cards"
    >
      {cards.map((approval) => (
        <ApprovalItem
          key={approval.runId}
          approval={approval}
          showSpace={false}
          onAnswered={refreshSoon}
          onOpen={() => onOpen(approval)}
        />
      ))}
    </ul>
  );
}
