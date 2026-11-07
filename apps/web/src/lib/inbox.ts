/** The bell spans the organization, so it is cached per person and refreshed by prefix. */
export function inboxQueryKey(userId: string | null) {
  return [`user:${userId ?? ""}`, "inbox"] as const;
}

export function isInboxQuery(query: { queryKey: readonly unknown[] }) {
  return query.queryKey[1] === "inbox";
}

/** The approvals list, under the bell's prefix so refreshing the bell refreshes it too. */
export function approvalsQueryKey(userId: string | null) {
  return [...inboxQueryKey(userId), "approvals"] as const;
}
