import type { SignedInAccounts } from "@rakazo/contracts";
import { MAX_SIGNED_IN_ACCOUNTS } from "@rakazo/contracts";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import {
  expireCookie,
  parseCookies,
  parseSetCookieHeader,
  setSessionCookie,
} from "better-auth/cookies";

type Ctx = GenericEndpointContext;
type FoundSession = NonNullable<
  Awaited<ReturnType<Ctx["context"]["internalAdapter"]["findSession"]>>
>;

const ACCOUNT_COOKIE_INFIX = "_account-";

/** Paths that can end the browser's session; another account it holds takes over. */
const SESSION_ENDING_PATHS = new Set(["/sign-out", "/delete-user"]);

/**
 * Keeps a browser signed in to several accounts. Every account holds its own signed, httpOnly
 * cookie next to the session cookie, which names the active one. Clients see accounts, never their
 * tokens: switching names a user, and the server moves that account's session into the session
 * cookie. Signing out ends only the active account, and the next one takes its place. Native
 * clients authenticate with a bearer and keep their own accounts, so bearer requests are left alone.
 */
export function signedInAccounts(enabled: boolean): BetterAuthPlugin {
  return {
    id: "signed-in-accounts",
    endpoints: {
      listSignedInAccounts: createAuthEndpoint(
        "/signed-in-accounts",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const current = ctx.context.session;
          const accounts: SignedInAccounts["accounts"] = [];
          if (enabled) {
            for (const held of await heldAccounts(ctx)) {
              if (held.userId === current.user.id) continue;
              const found = await liveSession(ctx, held);
              if (!found) continue;
              await keepAlive(ctx, held, found);
              accounts.push(describe(found, false));
            }
          }
          accounts.sort((a, b) => a.email.localeCompare(b.email));
          return ctx.json({ accounts: [describe(current, true), ...accounts] });
        },
      ),
      switchSignedInAccount: createAuthEndpoint(
        "/signed-in-accounts/switch",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
          if (!enabled || typeof userId !== "string" || !userId) throw new APIError("BAD_REQUEST");
          if (userId === ctx.context.session.user.id) return ctx.json({ userId });
          const held = (await heldAccounts(ctx)).find((account) => account.userId === userId);
          const found = held && (await liveSession(ctx, held));
          if (!found) {
            throw new APIError("UNAUTHORIZED", {
              code: "ACCOUNT_SIGNED_OUT",
              message: "This account is signed out",
            });
          }
          await setSessionCookie(ctx, found);
          return ctx.json({ userId });
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: () => enabled,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.headers?.get("authorization")) return;
            const issued = parseSetCookieHeader(
              ctx.context.responseHeaders?.get("set-cookie") ?? "",
            ).get(ctx.context.authCookies.sessionToken.name);
            if (!issued) return;
            if (issued.value && issued["max-age"] !== 0) {
              await remember(ctx);
            } else if (ctx.path && SESSION_ENDING_PATHS.has(ctx.path)) {
              await continueWithNextAccount(ctx);
            }
          }),
        },
      ],
    },
  };
}

type HeldAccount = { cookie: string; userId: string; token: string };

function accountCookie(ctx: Ctx, userId: string) {
  return `${ctx.context.authCookies.sessionToken.name}${ACCOUNT_COOKIE_INFIX}${userId}`;
}

/** The accounts whose cookies this request carries with a valid signature. */
async function heldAccounts(ctx: Ctx): Promise<HeldAccount[]> {
  const header = ctx.headers?.get("cookie");
  if (!header) return [];
  const prefix = accountCookie(ctx, "");
  const held = await Promise.all(
    [...parseCookies(header).keys()]
      .filter((cookie) => cookie.startsWith(prefix) && cookie.length > prefix.length)
      .map(async (cookie) => {
        const token = await ctx.getSignedCookie(cookie, ctx.context.secret);
        return typeof token === "string" && token
          ? { cookie, userId: cookie.slice(prefix.length), token }
          : null;
      }),
  );
  return held.filter((account) => account !== null);
}

/** The account's session, or null after expiring the cookie of one that ended. */
async function liveSession(ctx: Ctx, held: HeldAccount): Promise<FoundSession | null> {
  const found = await ctx.context.internalAdapter.findSession(held.token);
  if (found && found.user.id === held.userId && found.session.expiresAt > new Date()) return found;
  expireCookie(ctx, {
    name: held.cookie,
    attributes: ctx.context.authCookies.sessionToken.attributes,
  });
  return null;
}

function setAccountCookie(ctx: Ctx, userId: string, token: string) {
  return ctx.setSignedCookie(accountCookie(ctx, userId), token, ctx.context.secret, {
    ...ctx.context.authCookies.sessionToken.attributes,
    maxAge: ctx.context.sessionConfig.expiresIn,
  });
}

/**
 * A waiting account stays signed in while the browser is in use, as the active one does: once a
 * day it gets a fresh expiry, the same refresh a session read gives the active account.
 */
async function keepAlive(ctx: Ctx, held: HeldAccount, found: FoundSession) {
  const { expiresIn, updateAge } = ctx.context.sessionConfig;
  const refreshAt = found.session.expiresAt.getTime() - expiresIn * 1000 + updateAge * 1000;
  if (Date.now() < refreshAt) return;
  await ctx.context.internalAdapter.updateSession(held.token, {
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });
  await setAccountCookie(ctx, held.userId, held.token);
}

/**
 * The response signs the browser in to a session: keep a cookie for its account, and for the
 * account the browser held before when it is someone else, so adding an account keeps the first.
 */
async function remember(ctx: Ctx) {
  const signedIn = ctx.context.newSession;
  if (!signedIn) return;
  const held = await heldAccounts(ctx);
  const others = new Set(held.map((account) => account.userId));
  const previousToken = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  if (typeof previousToken === "string" && previousToken !== signedIn.session.token) {
    const previous = await ctx.context.internalAdapter.findSession(previousToken);
    if (
      previous &&
      previous.user.id !== signedIn.user.id &&
      previous.session.expiresAt > new Date() &&
      !others.has(previous.user.id) &&
      others.size < MAX_SIGNED_IN_ACCOUNTS
    ) {
      await setAccountCookie(ctx, previous.user.id, previousToken);
      others.add(previous.user.id);
    }
  }
  others.delete(signedIn.user.id);
  if (others.size >= MAX_SIGNED_IN_ACCOUNTS) return;
  await setAccountCookie(ctx, signedIn.user.id, signedIn.session.token);
}

/** The browser's session ended: drop that account and sign in to the next one it holds. */
async function continueWithNextAccount(ctx: Ctx) {
  const ended = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  let next: FoundSession | null = null;
  for (const held of await heldAccounts(ctx)) {
    if (held.token === ended) {
      expireCookie(ctx, {
        name: held.cookie,
        attributes: ctx.context.authCookies.sessionToken.attributes,
      });
      continue;
    }
    if (!next) next = await liveSession(ctx, held);
  }
  if (next) await setSessionCookie(ctx, next);
}

function describe(found: Pick<FoundSession, "user">, active: boolean) {
  return {
    userId: found.user.id,
    name: found.user.name,
    email: found.user.email,
    image: found.user.image ?? null,
    active,
  };
}
