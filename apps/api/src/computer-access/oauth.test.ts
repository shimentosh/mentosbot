import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { digestAccessToken } from "./access-keys.js";
import { approveAccess, mountComputerAccessOAuth, OAUTH_PATHS, safeRedirectUri } from "./oauth.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

const actor: Actor = {
  userId: "user_1",
  spaceId: "space_1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const REDIRECT = "https://ai.example.test/callback";
const VERIFIER = "a-verifier-that-is-long-enough-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

/** A store of codes and keys that behaves like the two tables. */
function fakePrisma() {
  const codes = new Map<string, Record<string, unknown>>();
  const keys: Array<Record<string, unknown>> = [];
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [{ id: "bot_1", name: "Ada" }]),
      findFirst: vi.fn(async () => ({ id: "bot_1" })),
    },
    computerAccessCode: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        codes.set(String(data.codeDigest), { id: `code_${codes.size}`, ...data });
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { codeDigest: string } }) => codes.get(where.codeDigest) ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id?: string } }) => {
        for (const [digest, row] of codes) {
          if (row.id === where.id && (row.expiresAt as Date) > new Date()) {
            codes.delete(digest);
            return { count: 1 };
          }
        }
        return { count: 0 };
      }),
    },
    computerAccessKey: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        keys.push(data);
        return { id: `key_${keys.length}` };
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, keys };
}

function oauthApp(prisma: PrismaClient) {
  const app = new Hono();
  mountComputerAccessOAuth(app, {
    prisma,
    env: { webOrigin: "https://rakazo.example.test" },
  } as unknown as RouterDeps);
  return app;
}

async function register(app: Hono, redirectUris: string[]) {
  return app.request(OAUTH_PATHS.register, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Desk AI", redirect_uris: redirectUris }),
  });
}

function trade(app: Hono, fields: Record<string, string>) {
  return app.request(OAUTH_PATHS.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", ...fields }).toString(),
  });
}

async function approvedCode(prisma: PrismaClient, app: Hono) {
  const { client_id: clientId } = (await (await register(app, [REDIRECT])).json()) as {
    client_id: string;
  };
  const back = new URL(
    await approveAccess(prisma, actor, {
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      state: "s1",
      botId: "bot_1",
      allowCommands: false,
    }),
  );
  return { clientId, code: back.searchParams.get("code")!, state: back.searchParams.get("state") };
}

describe("computer access sign-in", () => {
  it("trades an approved code, once, for a key named after the AI", async () => {
    const { prisma, keys } = fakePrisma();
    const app = oauthApp(prisma);
    const { clientId, code, state } = await approvedCode(prisma, app);
    expect(state).toBe("s1");
    const fields = { code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: clientId };
    const first = await trade(app, fields);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { access_token: string; token_type: string };
    expect(body.token_type).toBe("Bearer");
    expect(keys).toMatchObject([
      { botId: "bot_1", name: "Desk AI", tokenDigest: digestAccessToken(body.access_token) },
    ]);
    expect((await trade(app, fields)).status).toBe(400);
    expect(keys).toHaveLength(1);
  });

  it("refuses a code traded without its PKCE verifier", async () => {
    const { prisma, keys } = fakePrisma();
    const app = oauthApp(prisma);
    const { clientId, code } = await approvedCode(prisma, app);
    const response = await trade(app, {
      code,
      code_verifier: "someone-else-guessing-the-verifier-0123456789",
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(response.status).toBe(400);
    expect(keys).toHaveLength(0);
  });

  it("refuses to approve a return address the client did not register", async () => {
    const { prisma } = fakePrisma();
    const app = oauthApp(prisma);
    const { client_id: clientId } = (await (await register(app, [REDIRECT])).json()) as {
      client_id: string;
    };
    await expect(
      approveAccess(prisma, actor, {
        clientId,
        redirectUri: "https://attacker.example.test/callback",
        codeChallenge: CHALLENGE,
        botId: "bot_1",
        allowCommands: false,
      }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("registers only https, loopback http or an app's own return address", () => {
    expect(safeRedirectUri("https://ai.example.test/cb")).toBe(true);
    expect(safeRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(safeRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(safeRedirectUri("http://ai.example.test/cb")).toBe(false);
    expect(safeRedirectUri("javascript:alert(1)")).toBe(false);
  });
});
