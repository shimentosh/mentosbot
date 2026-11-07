import { createHash } from "node:crypto";
import type { AdapterContext, SecretStore, SignInCopy } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * The most a group's copy may hold to ride along with a page call: the supervisor caps a request
 * at 1 MiB and a page answer at 512 KiB plus this. A larger group keeps its sign-ins per computer.
 */
export const MAX_SIGN_IN_COPY_BYTES = 768 * 1024;

/** Two computers saving at once merge; a third collision in a row gives up on this save. */
const SAVE_ATTEMPTS = 3;

/** One group per person: their Global browsers share the same sign-ins, in every Space. */
export function signInGroupKey(userId: string): string {
  return createHash("sha256").update(`sign-ins\0${userId}`).digest("hex").slice(0, 32);
}

/** A browser's part in its sign-in group for one page call. */
export interface SignInShare {
  group: string;
  /** The group's copy, absent when it is too large to relay and stays on each computer. */
  copy?: SignInCopy;
  /** Keep what the call left in the group's copy. */
  save?(next: SignInCopy): Promise<void>;
}

export type SignInShareLookup = (
  botId: string,
  context: AdapterContext,
) => Promise<SignInShare | undefined>;

type Cookie = Record<string, unknown>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function cookieKey(cookie: Cookie): string {
  return stable([cookie.name, cookie.domain, cookie.path ?? null, cookie.partitionKey ?? null]);
}

function cookieMap(cookies: readonly Cookie[]): Map<string, Cookie> {
  return new Map(
    cookies
      .filter((cookie) => typeof cookie.name === "string" && typeof cookie.domain === "string")
      .map((cookie) => [cookieKey(cookie), cookie]),
  );
}

/**
 * The group after one browser's changes since `base`, applied onto `group`: the rule the page
 * browser merges by (see merge_cookies in rakazo-page-browser). Without a base the browser joins
 * afresh, adding what it has while the group's copy wins where both hold a cookie.
 */
export function mergeSignInCopies(
  mine: SignInCopy,
  base: SignInCopy | undefined,
  group: SignInCopy,
  nowSeconds = Date.now() / 1000,
): SignInCopy {
  const local = cookieMap(mine.cookies);
  const before = base ? cookieMap(base.cookies) : undefined;
  const theirs = cookieMap(group.cookies);
  const merged: Cookie[] = [];
  for (const key of new Set([...local.keys(), ...(before?.keys() ?? []), ...theirs.keys()])) {
    const own = local.get(key);
    const other = theirs.get(key);
    const pick = before ? (stable(own) !== stable(before.get(key)) ? own : other) : (other ?? own);
    const expires = typeof pick?.expires === "number" ? pick.expires : Number.POSITIVE_INFINITY;
    if (pick && expires > nowSeconds) merged.push(pick);
  }
  return { cookies: merged };
}

function parseCopy(plaintext: string): SignInCopy | undefined {
  try {
    const value = JSON.parse(plaintext) as { cookies?: unknown };
    if (!Array.isArray(value?.cookies)) return undefined;
    return {
      cookies: value.cookies.filter(
        (cookie): cookie is Cookie => Boolean(cookie) && typeof cookie === "object",
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Global browsers share one sign-in group per person, kept sealed on the server so it reaches the
 * computer of every Space they browse in. Each page call carries the copy there and back.
 */
export function browserSignInShares(deps: {
  prisma: PrismaClient;
  secretStore: SecretStore;
}): SignInShareLookup {
  const { prisma, secretStore } = deps;
  return async (botId, context) => {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { shareSignIns: true, userId: true },
    });
    if (!bot?.shareSignIns) return undefined;
    const userId = bot.userId;
    const group = signInGroupKey(userId);
    const recordId = `browser-sign-ins:${userId}`;
    const read = async () => {
      const row = await prisma.browserSignIns.findUnique({
        where: { userId },
        select: { ciphertext: true, version: true },
      });
      if (!row) return undefined;
      const copy = parseCopy(await secretStore.load(row.ciphertext, { recordId }));
      // An unreadable copy is replaced by the next save rather than blocking every call.
      return { ...row, copy: copy ?? { cookies: [], fresh: true } };
    };
    const stored = await read();
    const copy: SignInCopy = stored?.copy ?? { cookies: [], fresh: true };
    if (JSON.stringify(copy).length > MAX_SIGN_IN_COPY_BYTES) return { group };

    const save = async (returned: SignInCopy) => {
      let next: SignInCopy = { cookies: returned.cookies };
      let sent = { copy, version: stored?.version, ciphertext: stored?.ciphertext };
      for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
        if (JSON.stringify(next).length > MAX_SIGN_IN_COPY_BYTES) {
          getLogger().warn("browser_sign_ins.too_large", { "bot.id": botId });
          return;
        }
        const sealed = await secretStore.put(JSON.stringify(next), context, { recordId });
        const saved =
          sent.version === undefined
            ? await prisma.browserSignIns
                .create({ data: { userId, ciphertext: sealed.ciphertext, version: 1 } })
                .then(
                  () => true,
                  (error: unknown) => {
                    if ((error as { code?: string })?.code === "P2002") return false;
                    throw error;
                  },
                )
            : (
                await prisma.browserSignIns.updateMany({
                  where: { userId, version: sent.version },
                  data: { ciphertext: sealed.ciphertext, version: { increment: 1 } },
                })
              ).count === 1;
        const stale = saved ? sent.ciphertext : sealed.ciphertext;
        if (stale) await secretStore.delete(stale, { recordId }).catch(() => undefined);
        if (saved) return;
        // Another computer saved first: apply this call's changes onto what it saved.
        const current = await read();
        next = mergeSignInCopies(
          next,
          sent.copy.fresh ? undefined : sent.copy,
          current?.copy ?? { cookies: [] },
        );
        sent = {
          copy: current?.copy ?? { cookies: [], fresh: true },
          version: current?.version,
          ciphertext: current?.ciphertext,
        };
      }
      getLogger().warn("browser_sign_ins.save_conflict", { "bot.id": botId });
    };
    return { group, copy, save };
  };
}
