import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const session = { token: "token-ada" };
const api = vi.hoisted(() => ({
  apiBase: "https://one.example.test",
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => void store.delete(key)),
}));
vi.mock("./api", () => ({
  clearSpace: vi.fn(async () => true),
  currentApiBase: () => api.apiBase,
  fetchMobileJson: api.getSession,
  signOut: api.signOut,
}));
vi.mock("./push", () => ({
  registerPushToken: vi.fn(async () => undefined),
  unregisterPushToken: vi.fn(async () => undefined),
}));
vi.mock("./session", () => ({
  snapshotSessionToken: vi.fn(async () => ({ ok: true, value: session.token })),
  clearSessionToken: vi.fn(async () => {
    session.token = "";
    return true;
  }),
  saveSessionToken: vi.fn(async (token: string) => {
    session.token = token;
  }),
}));

const { unregisterPushToken, registerPushToken } = await import("./push");
const {
  canAddAccount,
  holdOpenAccount,
  openWaitingAccount,
  refreshWaitingAccounts,
  signOutAndContinue,
  waitingAccounts,
} = await import("./signed-in-accounts");

const ada = { userId: "user-ada", email: "ada@example.test", name: "Ada" };
const bo = { userId: "user-bo", email: "bo@example.test", name: "Bo" };

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  session.token = "token-ada";
  api.apiBase = "https://one.example.test";
  api.signOut.mockImplementation(async () => {
    session.token = "";
  });
});

describe("signed-in accounts on a phone", () => {
  it("keeps the open account and leaves it so another can sign in", async () => {
    await holdOpenAccount(ada);

    expect(session.token).toBe("");
    expect(unregisterPushToken).toHaveBeenCalledOnce();
    expect(await waitingAccounts()).toEqual([ada]);
  });

  it("switches between accounts, keeping each one signed in", async () => {
    await holdOpenAccount(ada);
    session.token = "token-bo";

    await openWaitingAccount(ada.userId, bo);

    expect(session.token).toBe("token-ada");
    expect(await waitingAccounts()).toEqual([bo]);
    expect(registerPushToken).toHaveBeenCalledOnce();
  });

  it("lists only the accounts of the server the phone uses", async () => {
    await holdOpenAccount(ada);
    api.apiBase = "https://two.example.test";

    expect(await waitingAccounts()).toEqual([]);
    await expect(openWaitingAccount(ada.userId)).rejects.toThrow("This account is signed out");
  });

  it("opens the next account after signing out, or reports none is left", async () => {
    await holdOpenAccount(ada);
    session.token = "token-bo";

    expect(await signOutAndContinue()).toBe(true);
    expect(session.token).toBe("token-ada");
    expect(await waitingAccounts()).toEqual([]);

    expect(await signOutAndContinue()).toBe(false);
    expect(session.token).toBe("");
  });

  it("drops an account whose session ended and keeps one it cannot reach", async () => {
    await holdOpenAccount(ada);
    session.token = "token-bo";
    await holdOpenAccount(bo);
    api.getSession.mockImplementation(async (_url: string, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).authorization;
      if (bearer === "Bearer token-ada")
        return { response: new Response(null, { status: 401 }), body: null };
      throw new Error("offline");
    });

    expect(await refreshWaitingAccounts()).toEqual([bo]);
  });

  it("puts the account back when opening it fails", async () => {
    await holdOpenAccount(ada);
    const { saveSessionToken } = await import("./session");
    vi.mocked(saveSessionToken).mockRejectedValueOnce(new Error("keychain locked"));

    await expect(openWaitingAccount(ada.userId)).rejects.toThrow("keychain locked");
    expect(await waitingAccounts()).toEqual([ada]);
  });

  it("leaves room for the open account within the limit", () => {
    expect(canAddAccount([ada, bo, ada, bo].slice(0, 3))).toBe(true);
    expect(canAddAccount([ada, bo, ada, bo])).toBe(false);
  });
});
