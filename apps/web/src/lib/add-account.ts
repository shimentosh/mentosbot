/** The sign-in page adds an account while the user it names stays signed in. */
export const ADD_ACCOUNT_PARAM = "add";

/** Where "Add account" goes: the sign-in page, kept open while this user is signed in. */
export function addAccountPath(userId: string): string {
  return `/sign-in?${new URLSearchParams({ [ADD_ACCOUNT_PARAM]: userId })}`;
}
