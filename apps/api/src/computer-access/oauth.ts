import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "../http/http-body.js";
import type { RouterDeps } from "../router.js";
import {
  accessOrigin,
  COMPUTER_ACCESS_PATH,
  computerAccessUrl,
  digestAccessToken,
  newAccessToken,
} from "./access-keys.js";

/**
 * Sign-in for outside AIs, so an app that only takes a server's address (a chat app's custom
 * connector, say) can still be given one bot's computer: OAuth 2.1 with PKCE, as MCP asks for.
 * The access token it ends with is an ordinary computer access key, listed and removable with
 * the others.
 */

export const OAUTH_PATHS = {
  resource: "/.well-known/oauth-protected-resource",
  server: "/.well-known/oauth-authorization-server",
  register: "/api/v1/oauth/register",
  token: "/api/v1/oauth/token",
} as const;
/** The web page where the owner approves an AI and picks its bot. */
export const OAUTH_APPROVE_PAGE = "/connect-ai";

const CLIENT_PREFIX = "rkc-client_";
const CODE_TTL_MS = 2 * 60_000;
const MAX_CLIENT_NAME = 80;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI = 500;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const MAX_TOKEN_BODY_BYTES = 16 * 1024;
/** Schemes a browser must never be sent to with a code. */
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resourceMetadataUrl(origin: string): string {
  return `${origin}${OAUTH_PATHS.resource}${COMPUTER_ACCESS_PATH}`;
}

/** Where an AI may send people back to: https, a loopback http address, or an app's own scheme. */
export function safeRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.hash || url.username || url.password || UNSAFE_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return true;
}

type Client = { name: string; redirectUris: string[] };

/**
 * Registration keeps nothing: the client id carries the client's name and return addresses.
 * Anyone may register any client, as open registration allows, so the id needs no signature;
 * what protects the owner is the approval page naming the AI and where it returns.
 */
function encodeClient(client: Client): string {
  return `${CLIENT_PREFIX}${Buffer.from(JSON.stringify({ n: client.name, r: client.redirectUris })).toString("base64url")}`;
}

export function decodeClient(clientId: string): Client | null {
  if (!clientId.startsWith(CLIENT_PREFIX)) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(clientId.slice(CLIENT_PREFIX.length), "base64url").toString("utf8"),
    ) as { n?: unknown; r?: unknown };
    if (typeof raw.n !== "string" || !Array.isArray(raw.r)) return null;
    const redirectUris = raw.r.filter((uri): uri is string => typeof uri === "string");
    if (redirectUris.length !== raw.r.length || !redirectUris.every(safeRedirectUri)) return null;
    return { name: raw.n.slice(0, MAX_CLIENT_NAME), redirectUris };
  } catch {
    return null;
  }
}

/** The client a sign-in request names, when it may return to that address. */
export function requestedClient(clientId: string, redirectUri: string): Client {
  const client = decodeClient(clientId);
  if (!client?.redirectUris.includes(redirectUri)) {
    throw new ClientError(
      "BAD_REQUEST",
      "This sign-in link is not valid. Start again from the AI.",
    );
  }
  return client;
}

/** The owner's bots with a computer: the ones an AI can be given. */
export async function grantableBots(prisma: PrismaClient, actor: Actor) {
  return prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      computerId: { not: null },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** Approve a sign-in for one bot: a one-time code the AI trades for its key. */
export async function approveAccess(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    botId: string;
    allowCommands: boolean;
  },
): Promise<string> {
  const client = requestedClient(input.clientId, input.redirectUri);
  const bots = await grantableBots(prisma, actor);
  if (!bots.some((bot) => bot.id === input.botId)) {
    throw new ClientError("NOT_FOUND", "Bot not found");
  }
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  // Codes nobody traded are of no use once they expire.
  await prisma.computerAccessCode.deleteMany({
    where: { userId: actor.userId, expiresAt: { lt: new Date(now) } },
  });
  await prisma.computerAccessCode.create({
    data: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: input.botId,
      codeDigest: digestAccessToken(code),
      name: client.name || "AI",
      allowCommands: input.allowCommands,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(now + CODE_TTL_MS),
    },
  });
  const back = new URL(input.redirectUri);
  back.searchParams.set("code", code);
  if (input.state !== undefined) back.searchParams.set("state", input.state);
  return back.toString();
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
  c.header("Cache-Control", "no-store");
  return c.json({ error, error_description: description }, status);
}

async function formOrJson(request: Request, limit: number): Promise<Record<string, string> | null> {
  const raw = await readBoundedBody(request, limit);
  if (raw === null) return null;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return null;
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function mountComputerAccessOAuth(app: Hono, deps: RouterDeps) {
  const origin = () => accessOrigin(deps.env);

  const resourceMetadata = (c: Context) =>
    c.json({
      resource: computerAccessUrl(origin()),
      authorization_servers: [origin()],
      bearer_methods_supported: ["header"],
      scopes_supported: ["computer"],
    });
  app.get(OAUTH_PATHS.resource, resourceMetadata);
  app.get(`${OAUTH_PATHS.resource}${COMPUTER_ACCESS_PATH}`, resourceMetadata);

  app.get(OAUTH_PATHS.server, (c) =>
    c.json({
      issuer: origin(),
      authorization_endpoint: `${origin()}${OAUTH_APPROVE_PAGE}`,
      token_endpoint: `${origin()}${OAUTH_PATHS.token}`,
      registration_endpoint: `${origin()}${OAUTH_PATHS.register}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["computer"],
    }),
  );

  app.post(OAUTH_PATHS.register, async (c) => {
    const raw = await readBoundedBody(c.req.raw, MAX_REGISTRATION_BYTES);
    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = raw === null ? {} : (JSON.parse(raw) as typeof body);
    } catch {
      return oauthError(c, "invalid_client_metadata", "The body must be JSON.");
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      uris.length === 0 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every((uri) => typeof uri === "string" && safeRedirectUri(uri))
    ) {
      return oauthError(c, "invalid_redirect_uri", "Give 1 to 5 https or loopback redirect URIs.");
    }
    const name =
      typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim().slice(0, MAX_CLIENT_NAME)
        : "AI";
    const client = { name, redirectUris: uris as string[] };
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        client_id: encodeClient(client),
        client_name: name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  app.post(OAUTH_PATHS.token, async (c) => {
    const params = await formOrJson(c.req.raw, MAX_TOKEN_BODY_BYTES);
    if (!params) return oauthError(c, "invalid_request", "Unreadable request.");
    if (params.grant_type !== "authorization_code") {
      return oauthError(c, "unsupported_grant_type", "Only authorization_code is supported.");
    }
    const {
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    } = params;
    if (!code || !verifier || !redirectUri || !clientId) {
      return oauthError(
        c,
        "invalid_request",
        "code, code_verifier, redirect_uri and client_id are required.",
      );
    }
    const row = await deps.prisma.computerAccessCode.findUnique({
      where: { codeDigest: digestAccessToken(code) },
    });
    // One trade per code: whoever deletes it first gets the key.
    const taken = row
      ? await deps.prisma.computerAccessCode.deleteMany({
          where: { id: row.id, expiresAt: { gt: new Date() } },
        })
      : { count: 0 };
    if (
      !row ||
      taken.count !== 1 ||
      !sameText(row.clientId, clientId) ||
      !sameText(row.redirectUri, redirectUri) ||
      !sameText(row.codeChallenge, s256(verifier))
    ) {
      return oauthError(c, "invalid_grant", "The code is not valid. Sign in again.");
    }
    const bot = await deps.prisma.bot.findFirst({
      where: { id: row.botId, spaceId: row.spaceId, userId: row.userId, archivedAt: null },
      select: { id: true },
    });
    if (!bot) return oauthError(c, "invalid_grant", "The bot is no longer available.");
    const { token, digest, hint } = newAccessToken();
    const key = await deps.prisma.computerAccessKey.create({
      data: {
        spaceId: row.spaceId,
        userId: row.userId,
        botId: row.botId,
        name: row.name,
        tokenDigest: digest,
        tokenHint: hint,
        allowCommands: row.allowCommands,
      },
      select: { id: true },
    });
    await recordSecurityEvent({
      type: "credential.created",
      userId: row.userId,
      spaceId: row.spaceId,
      metadata: { kind: "computer_access_key", botId: row.botId, keyId: key.id, via: "oauth" },
    });
    c.header("Cache-Control", "no-store");
    return c.json({ access_token: token, token_type: "Bearer", scope: "computer" });
  });
}
