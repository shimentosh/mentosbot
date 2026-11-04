import type { Bot, ThreadMessage } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useOrganizations } from "../../lib/organizations";
import { queryClient } from "../../lib/query";
import { rpc } from "../../lib/rpc";

/**
 * Who wrote a person's message in a bot's chat, when it was someone other than the viewer: a
 * shared bot's chat holds its owner's messages and every teammate's it is shared with.
 */
export function useMessageAuthorName(bot: Bot | undefined, userId: string | undefined) {
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((each) => each.id === activeOrganizationId);
  const { data: team } = useQuery(
    {
      queryKey: [`user:${userId ?? ""}`, "team", activeOrganizationId ?? ""],
      queryFn: () => rpc.team.get({ organizationId: activeOrganizationId! }),
      enabled: Boolean(userId && activeOrganizationId && (organization?.memberCount ?? 0) > 1),
    },
    queryClient,
  );
  return useCallback(
    (message: ThreadMessage) => {
      if (message.role !== "user" || !bot) return undefined;
      const author = message.authorUserId ?? bot.share?.ownerUserId ?? userId;
      if (!author || author === userId) return undefined;
      if (author === bot.share?.ownerUserId) return bot.share.ownerName;
      const member = team?.members.find((each) => each.userId === author);
      return member ? member.name.trim() || member.email : undefined;
    },
    [bot, userId, team],
  );
}
