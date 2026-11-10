import { MAX_SIGNED_IN_ACCOUNTS } from "@rakazo/contracts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedBearer } from "./account-security.js";
import { signedInAccounts } from "./signed-in-accounts.js";

const ORIGIN = "https://app.example.test";

function setup(enabled = true) {
  const auth = betterAuth({
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    // Better Auth skips the origin check under test unless told otherwise; production keeps it.
    advanced: { disableOriginCheck: false },
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true },
    plugins: [signedBearer, signedInAccounts(enabled)],
  });
  /** A browser: sends its cookies and applies every Set-Cookie in order. */
  const jar = new Map<string, string>();
  const send = async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(jar.size
            ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") }
            : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0"))
        jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const signUp = async (name: string) => {
    const response = await send("/sign-up/email", {
      body: { email: `${name}@example.test`, password: "password-1234", name },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { user: { id: string } }).user.id;
  };
  const current = async () =>
    ((await (await send("/get-session")).json()) as { user: { email: string } } | null)?.user
      .email ?? null;
  const accounts = async () => {
    const response = await send("/signed-in-accounts");
    const text = await response.text();
    return {
      status: response.status,
      text,
      body: JSON.parse(text) as { accounts: { email: string; active: boolean }[] },
    };
  };
  return { auth, jar, send, signUp, current, accounts };
}

describe("signed-in accounts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the first account when another signs in, and lists both without tokens", async () => {
    const browser = setup();
    await browser.signUp("ada");
    await browser.signUp("bo");

    expect(await browser.current()).toBe("bo@example.test");
    const listed = await browser.accounts();
    expect(listed.body.accounts.map(({ email, active }) => [email, active])).toEqual([
      ["bo@example.test", true],
      ["ada@example.test", false],
    ]);
    expect(listed.text).not.toMatch(/token/i);
  });

  it("switches by user, and refuses an account the browser does not hold", async () => {
    const browser = setup();
    const ada = await browser.signUp("ada");
    await browser.signUp("bo");

    expect(
      (await browser.send("/signed-in-accounts/switch", { body: { userId: ada } })).status,
    ).toBe(200);
    expect(await browser.current()).toBe("ada@example.test");

    const stranger = setup();
    const other = await stranger.signUp("cy");
    expect(
      (await browser.send("/signed-in-accounts/switch", { body: { userId: other } })).status,
    ).toBe(401);
    expect(await browser.current()).toBe("ada@example.test");
  });

  it("refuses a switch from another site", async () => {
    const browser = setup();
    const ada = await browser.signUp("ada");
    await browser.signUp("bo");

    const response = await browser.send("/signed-in-accounts/switch", {
      body: { userId: ada },
      headers: { origin: "https://evil.example.test" },
    });
    expect(response.status).toBe(403);
    expect(await browser.current()).toBe("bo@example.test");
  });

  it("signs out only the active account, then the next one", async () => {
    const browser = setup();
    await browser.signUp("ada");
    await browser.signUp("bo");

    expect((await browser.send("/sign-out", { body: {} })).status).toBe(200);
    expect(await browser.current()).toBe("ada@example.test");
    expect((await browser.accounts()).body.accounts.map(({ email }) => email)).toEqual([
      "ada@example.test",
    ]);

    await browser.send("/sign-out", { body: {} });
    expect(await browser.current()).toBeNull();
    expect([...browser.jar.keys()].filter((name) => name.includes("session_token"))).toEqual([]);
  });

  it("drops an account whose session ended elsewhere", async () => {
    const browser = setup();
    await browser.signUp("ada");
    await browser.signUp("bo");
    const ctx = await browser.auth.$context;
    const ada = await ctx.internalAdapter.findUserByEmail("ada@example.test");
    for (const { token } of await ctx.internalAdapter.listSessions(ada!.user.id))
      await ctx.internalAdapter.deleteSession(token);

    expect((await browser.accounts()).body.accounts.map(({ email }) => email)).toEqual([
      "bo@example.test",
    ]);
    expect([...browser.jar.keys()].some((name) => name.endsWith(ada!.user.id))).toBe(false);
  });

  it("keeps a waiting account signed in while the browser is in use", async () => {
    const browser = setup();
    await browser.signUp("ada");
    await browser.signUp("bo");
    const ctx = await browser.auth.$context;
    const ada = await ctx.internalAdapter.findUserByEmail("ada@example.test");
    const [before] = await ctx.internalAdapter.listSessions(ada!.user.id);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect((await browser.accounts()).body.accounts).toHaveLength(2);

    const [after] = await ctx.internalAdapter.listSessions(ada!.user.id);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
  });

  it("leaves a bearer sign-out to the native client", async () => {
    const browser = setup();
    const ada = await browser.signUp("ada");
    const bo = await browser.send("/sign-up/email", {
      body: { email: "bo@example.test", password: "password-1234", name: "bo" },
    });
    const bearer = bo.headers.get("set-auth-token")!;

    await browser.send("/sign-out", { body: {}, headers: { authorization: `Bearer ${bearer}` } });
    expect(await browser.current()).toBeNull();
    expect([...browser.jar.keys()].some((name) => name.endsWith(`_account-${ada}`))).toBe(true);
  });

  it(`keeps at most ${MAX_SIGNED_IN_ACCOUNTS} accounts`, async () => {
    const browser = setup();
    for (let index = 0; index <= MAX_SIGNED_IN_ACCOUNTS; index += 1)
      await browser.signUp(`user${index}`);

    const held = [...browser.jar.keys()].filter((name) => name.includes("_account-"));
    expect(held).toHaveLength(MAX_SIGNED_IN_ACCOUNTS);
  });

  it("keeps one account when turned off", async () => {
    const browser = setup(false);
    const ada = await browser.signUp("ada");
    await browser.signUp("bo");

    expect((await browser.accounts()).body.accounts.map(({ email }) => email)).toEqual([
      "bo@example.test",
    ]);
    expect(
      (await browser.send("/signed-in-accounts/switch", { body: { userId: ada } })).status,
    ).toBe(400);
  });
});
