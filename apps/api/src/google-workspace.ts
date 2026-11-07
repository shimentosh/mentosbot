import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import {
  exchangeGoogleCode,
  GOOGLE_WORKSPACE_CLIENT_KIND,
  GOOGLE_WORKSPACE_CONNECTOR_ID,
  GOOGLE_WORKSPACE_STATE_TTL_MS,
  GOOGLE_WORKSPACE_TOKEN_KIND,
  GoogleAuthError,
  googleAuthorizationUrl,
  googleStateDigest,
  loadGoogleClient,
  newGoogleState,
  parseGoogleTokens,
  revokeGoogleToken,
} from "@rakazo/adapters";
import type { Actor, GoogleWorkspaceClient, GoogleWorkspaceState } from "@rakazo/contracts";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "secrets" | "env">;
type Owner = Pick<Actor, "userId" | "spaceId">;

export function googleWorkspaceRedirectUri(deps: Pick<Deps, "env">): string {
  return `${deps.env.webOrigin}/integrations/google/callback`;
}

function context(owner: Owner, operation: string): AdapterContext {
  return {
    operationId: operation,
    traceId: operation,
    spaceId: owner.spaceId,
    userId: owner.userId,
    signal: new AbortController().signal,
  };
}

export async function getGoogleWorkspace(deps: Deps, owner: Owner): Promise<GoogleWorkspaceState> {
  const [client, account] = await Promise.all([
    loadGoogleClient(deps.prisma, deps.secrets, owner.userId).catch(() => null),
    deps.prisma.connection.findFirst({
      where: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        status: "connected",
      },
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  return {
    redirectUri: googleWorkspaceRedirectUri(deps),
    clientId: client?.client.clientId ?? null,
    account: account
      ? { email: account.displayName, connectedAt: account.updatedAt.toISOString() }
      : null,
  };
}

/** Drop the user's Google rows in one space (or all), revoking each token with Google. */
async function removeAccounts(
  deps: Deps,
  where: { userId: string; spaceId?: string },
): Promise<void> {
  const rows = await deps.prisma.connection.findMany({
    where: {
      userId: where.userId,
      ...(where.spaceId ? { spaceId: where.spaceId } : {}),
      connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
    },
    select: { id: true, secretId: true },
  });
  for (const row of rows) {
    if (!row.secretId) continue;
    const secret = await deps.prisma.secret.findUnique({ where: { id: row.secretId } });
    if (!secret) continue;
    const tokens = await deps.secrets
      .load(secret.ciphertext, { recordId: secret.id })
      .then(parseGoogleTokens)
      .catch(() => null);
    if (tokens) await revokeGoogleToken(tokens.refreshToken);
  }
  await deps.prisma.$transaction(async (tx) => {
    await tx.connection.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    await tx.secret.deleteMany({
      where: {
        id: { in: rows.flatMap((row) => (row.secretId ? [row.secretId] : [])) },
        userId: where.userId,
      },
    });
  });
}

/** A new client replaces the old one, and accounts signed in through the old one go with it. */
export async function saveGoogleWorkspaceClient(
  deps: Deps,
  owner: Owner,
  input: GoogleWorkspaceClient,
): Promise<GoogleWorkspaceState> {
  const previous = await loadGoogleClient(deps.prisma, deps.secrets, owner.userId).catch(
    () => null,
  );
  const unchanged =
    previous?.client.clientId === input.clientId &&
    previous.client.clientSecret === input.clientSecret;
  if (!unchanged) {
    if (previous) await removeAccounts(deps, { userId: owner.userId });
    const stored = await deps.secrets.put(
      JSON.stringify(input),
      context(owner, "googleWorkspace.saveClient"),
    );
    await deps.prisma.$transaction(async (tx) => {
      await tx.secret.deleteMany({
        where: { userId: owner.userId, kind: GOOGLE_WORKSPACE_CLIENT_KIND },
      });
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: owner.userId,
          spaceId: null,
          kind: GOOGLE_WORKSPACE_CLIENT_KIND,
          ciphertext: stored.ciphertext,
        },
      });
    });
  }
  return getGoogleWorkspace(deps, owner);
}

export async function beginGoogleWorkspace(
  deps: Deps,
  owner: Owner,
): Promise<{ authorizationUrl: string }> {
  const client = await loadGoogleClient(deps.prisma, deps.secrets, owner.userId);
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "Add your OAuth client first." });
  const { state, digest } = newGoogleState();
  await deps.prisma.$transaction(async (tx) => {
    // One sign-in in flight per space; a new one replaces an abandoned one.
    await tx.connection.deleteMany({
      where: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        status: "pending",
      },
    });
    await tx.connection.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        provider: GOOGLE_WORKSPACE_CONNECTOR_ID,
        displayName: "Google Workspace",
        status: "pending",
        providerRef: digest,
        metadata: { expiresAt: Date.now() + GOOGLE_WORKSPACE_STATE_TTL_MS },
      },
    });
  });
  return {
    authorizationUrl: googleAuthorizationUrl({
      clientId: client.client.clientId,
      redirectUri: googleWorkspaceRedirectUri(deps),
      state,
    }),
  };
}

/**
 * Finish the sign-in the state names. The state alone picks the space it was started in, so
 * the callback page does not depend on which space it opens in.
 */
export async function completeGoogleWorkspace(
  deps: Deps,
  actor: Owner,
  input: { code: string; state: string },
): Promise<GoogleWorkspaceState> {
  const pending = await deps.prisma.connection.findFirst({
    where: {
      userId: actor.userId,
      connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
      status: "pending",
      providerRef: googleStateDigest(input.state),
    },
  });
  const expiresAt = Number((pending?.metadata as { expiresAt?: unknown } | null)?.expiresAt ?? 0);
  if (!pending || expiresAt < Date.now()) {
    throw new ORPCError("BAD_REQUEST", {
      message: "This sign-in expired or was already used. Start again from Integrations.",
    });
  }
  const owner = { userId: actor.userId, spaceId: pending.spaceId };
  const client = await loadGoogleClient(deps.prisma, deps.secrets, owner.userId);
  if (!client) throw new ORPCError("BAD_REQUEST", { message: "Add your OAuth client first." });
  let tokens: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    tokens = await exchangeGoogleCode({
      client: client.client,
      code: input.code,
      redirectUri: googleWorkspaceRedirectUri(deps),
    });
  } catch (error) {
    await deps.prisma.connection.deleteMany({ where: { id: pending.id } });
    throw new ORPCError("BAD_REQUEST", {
      message:
        error instanceof GoogleAuthError
          ? `Google rejected the sign-in: ${error.message}`
          : "Could not reach Google. Try again.",
    });
  }
  // The new account replaces any earlier one in this space, and the used state goes with them.
  await removeAccounts(deps, owner);
  const stored = await deps.secrets.put(
    JSON.stringify(tokens),
    context(owner, "googleWorkspace.complete"),
  );
  await deps.prisma.$transaction(async (tx) => {
    await tx.secret.create({
      data: {
        id: stored.id,
        userId: owner.userId,
        spaceId: owner.spaceId,
        kind: GOOGLE_WORKSPACE_TOKEN_KIND,
        ciphertext: stored.ciphertext,
      },
    });
    await tx.connection.create({
      data: {
        userId: owner.userId,
        spaceId: owner.spaceId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        provider: GOOGLE_WORKSPACE_CONNECTOR_ID,
        displayName: tokens.email,
        status: "connected",
        secretId: stored.id,
        providerRef: tokens.email,
      },
    });
  });
  return getGoogleWorkspace(deps, owner);
}

export async function disconnectGoogleWorkspace(
  deps: Deps,
  owner: Owner,
): Promise<GoogleWorkspaceState> {
  await removeAccounts(deps, owner);
  return getGoogleWorkspace(deps, owner);
}
