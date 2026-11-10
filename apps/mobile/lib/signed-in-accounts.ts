import { MAX_SIGNED_IN_ACCOUNTS } from "@rakazo/contracts";
import * as SecureStore from "expo-secure-store";
import { clearSpace, currentApiBase, fetchMobileJson, signOut } from "./api";
import { t } from "./i18n";
import { registerPushToken, unregisterPushToken } from "./push";
import { clearSessionToken, saveSessionToken, snapshotSessionToken } from "./session";

const ACCOUNTS_KEY = "rakazo.signed_in_accounts";

/** The account that is open, as the server describes it. */
export type OpenAccount = { userId: string; email: string; name: string };

/**
 * An account this phone stays signed in to while another is open. Its bearer stays in SecureStore,
 * tied to the server that issued it.
 */
type HeldAccount = OpenAccount & { apiBase: string; token: string };

/** What a screen shows of an account waiting on this server. */
export type WaitingAccount = OpenAccount;

let writes: Promise<unknown> = Promise.resolve();

/** Read-modify-write under one queue, so two account changes cannot drop each other's write. */
function update<T>(
  change: (accounts: HeldAccount[]) => Promise<[HeldAccount[], T]> | [HeldAccount[], T],
) {
  const next = writes.then(async () => {
    const [accounts, result] = await change(await readHeld());
    if (accounts.length) await SecureStore.setItemAsync(ACCOUNTS_KEY, JSON.stringify(accounts));
    else await SecureStore.deleteItemAsync(ACCOUNTS_KEY);
    return result;
  });
  writes = next.catch(() => undefined);
  return next;
}

async function readHeld(): Promise<HeldAccount[]> {
  try {
    const parsed: unknown = JSON.parse((await SecureStore.getItemAsync(ACCOUNTS_KEY)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isHeldAccount) : [];
  } catch {
    return [];
  }
}

function isHeldAccount(value: unknown): value is HeldAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return ["apiBase", "userId", "email", "name", "token"].every(
    (key) => typeof account[key] === "string",
  );
}

const onServer = (apiBase: string) => (account: HeldAccount) => account.apiBase === apiBase;
const describe = ({ userId, email, name }: HeldAccount): WaitingAccount => ({
  userId,
  email,
  name,
});

/** The other accounts this phone is signed in to on the current server. */
export async function waitingAccounts(): Promise<WaitingAccount[]> {
  await writes;
  return (await readHeld()).filter(onServer(currentApiBase())).map(describe);
}

/** Whether another account fits next to `open` on this server. */
export function canAddAccount(waiting: readonly WaitingAccount[]): boolean {
  return waiting.length + 1 < MAX_SIGNED_IN_ACCOUNTS;
}

/**
 * Asks the server about each waiting account: one whose session ended is dropped, and the rest
 * stay signed in as long as the phone is used, as the open one does.
 */
export async function refreshWaitingAccounts(): Promise<WaitingAccount[]> {
  const apiBase = currentApiBase();
  const ended = new Set<string>();
  await Promise.all(
    (await readHeld()).filter(onServer(apiBase)).map(async (account) => {
      try {
        const { response, body } = await fetchMobileJson<{ user?: { id?: string } } | null>(
          `${apiBase}/api/auth/get-session`,
          { headers: { origin: "rakazo://", authorization: `Bearer ${account.token}` } },
          null,
        );
        if (response.status === 401 || (response.ok && body?.user?.id !== account.userId))
          ended.add(account.token);
      } catch {
        // Offline: keep it; the next look asks again.
      }
    }),
  );
  if (ended.size) await update((accounts) => [accounts.filter((a) => !ended.has(a.token)), null]);
  return waitingAccounts();
}

/**
 * Keeps the open account signed in and leaves it on this phone, so another account can sign in or
 * open. Its notifications stop here until it is open again.
 */
export async function holdOpenAccount(open: OpenAccount): Promise<void> {
  const token = await snapshotSessionToken();
  if (!token.ok || !token.value)
    throw new Error(t("Could not save your sign-in on this device. Try again."));
  const apiBase = currentApiBase();
  await update((accounts) => [
    [
      ...accounts.filter((a) => !(a.apiBase === apiBase && a.userId === open.userId)),
      { ...open, apiBase, token: token.value },
    ],
    null,
  ]);
  await unregisterPushToken();
  const sessionCleared = await clearSessionToken();
  const spaceCleared = await clearSpace();
  if (!sessionCleared || !spaceCleared) throw new Error(t("Could not clear the local session"));
}

/** Opens an account this phone is signed in to, keeping the open one (if any) signed in too. */
export async function openWaitingAccount(userId: string, open?: OpenAccount): Promise<void> {
  const apiBase = currentApiBase();
  const next = await update((accounts) => {
    const found = accounts.find((a) => a.apiBase === apiBase && a.userId === userId);
    return [accounts.filter((a) => a !== found), found];
  });
  if (!next) throw new Error(t("This account is signed out"));
  try {
    if (open) await holdOpenAccount(open);
    await saveSessionToken(next.token);
  } catch (error) {
    await update((accounts) => [[...accounts, next], null]);
    throw error;
  }
  void registerPushToken().catch(() => undefined);
}

/**
 * Signs the open account out. Returns true when another account this phone is signed in to on
 * the same server took its place, false when the phone is now signed out.
 */
export async function signOutAndContinue(): Promise<boolean> {
  await signOut();
  const [next] = await waitingAccounts();
  if (!next) return false;
  try {
    await openWaitingAccount(next.userId);
    return true;
  } catch {
    return false;
  }
}
