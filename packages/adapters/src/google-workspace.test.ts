import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_WORKSPACE_CONNECTOR_ID,
  GOOGLE_WORKSPACE_SCOPES,
  GoogleWorkspaceConnector,
  googleAuthorizationUrl,
  googleStateDigest,
  newGoogleState,
} from "./google-workspace.js";
import { EncryptedSecretStore } from "./secrets.js";

const KEY = "test-encryption-key-test-encryption-key";

function context(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "op",
    traceId: "op",
    spaceId: "space-1",
    userId: "user-1",
    signal: new AbortController().signal,
    connectedConnections: [
      {
        id: "conn-1",
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        externalId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        displayName: "person@example.test",
      },
    ],
    ...extra,
  };
}

async function setup(tokens: { accessToken: string; expiresAt: number }) {
  const secrets = new EncryptedSecretStore(KEY);
  const ctx = context();
  const client = await secrets.put(
    JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }),
    ctx,
  );
  const token = await secrets.put(
    JSON.stringify({ refreshToken: "refresh-1", email: "person@example.test", ...tokens }),
    ctx,
  );
  const rows = new Map([
    [client.id, { id: client.id, ciphertext: client.ciphertext }],
    [token.id, { id: token.id, ciphertext: token.ciphertext }],
  ]);
  const prisma = {
    connection: {
      findFirst: vi.fn(async () => ({ userId: "user-1", secretId: token.id })),
    },
    secret: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findFirst: vi.fn(async () => rows.get(client.id)),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { ciphertext: string } }) => {
          rows.set(where.id, { id: where.id, ciphertext: data.ciphertext });
        },
      ),
    },
  } as unknown as PrismaClient;
  return { secrets, prisma, rows, tokenId: token.id };
}

async function collect(events: AsyncIterable<ConnectorEvent>): Promise<ConnectorEvent[]> {
  const out: ConnectorEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("google workspace sign-in", () => {
  it("asks for offline access to every workspace scope and carries the state", () => {
    const url = new URL(
      googleAuthorizationUrl({
        clientId: "client-id",
        redirectUri: "https://app.example.test/integrations/google/callback",
        state: "state-1",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_WORKSPACE_SCOPES);
  });

  it("stores only a digest of the state", () => {
    const { state, digest } = newGoogleState();
    expect(digest).toBe(googleStateDigest(state));
    expect(digest).not.toContain(state);
  });
});

describe("GoogleWorkspaceConnector", () => {
  it("offers tools only when a Google account is connected, pinned to that account", async () => {
    const { prisma, secrets } = await setup({
      accessToken: "a",
      expiresAt: Date.now() + 3_600_000,
    });
    const connector = new GoogleWorkspaceConnector({ prisma, secrets });
    expect(await connector.discoverTools(context({ connectedConnections: [] }))).toEqual([]);
    const tools = await connector.discoverTools(context());
    expect(tools.map((tool) => tool.name)).toContain("gmail_send");
    expect(tools.find((tool) => tool.name === "gmail_send")?.readOnly).toBe(false);
    expect(tools.find((tool) => tool.name === "drive_search")?.readOnly).toBe(true);
    expect(tools.every((tool) => tool.route?.connectionId === "conn-1")).toBe(true);
  });

  it("refreshes an expired token, saves it, and calls the API with it", async () => {
    const { prisma, secrets, rows, tokenId } = await setup({ accessToken: "old", expiresAt: 0 });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-1");
        expect(body.get("client_secret")).toBe("client-secret");
        return json({ access_token: "fresh", expires_in: 3600 });
      }
      expect(url).toContain("https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh");
      return json({ values: [["a", "b"]] });
    });
    const connector = new GoogleWorkspaceConnector({ prisma, secrets, fetch });
    const events = await collect(
      connector.execute(
        {
          tool: "sheets_read",
          args: { spreadsheetId: "sheet-1", range: "Sheet1!A1:B1" },
          executionId: "e1",
        },
        context(),
      ),
    );
    expect(events).toEqual([{ type: "result", data: { values: [["a", "b"]] } }]);
    const stored = JSON.parse(
      await secrets.load(rows.get(tokenId)!.ciphertext, { recordId: tokenId }),
    );
    expect(stored).toMatchObject({ accessToken: "fresh", refreshToken: "refresh-1" });
  });

  it("tells the bot to reconnect when Google revoked access", async () => {
    const { prisma, secrets } = await setup({ accessToken: "old", expiresAt: 0 });
    const fetch = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    const connector = new GoogleWorkspaceConnector({ prisma, secrets, fetch });
    const [event] = await collect(
      connector.execute(
        { tool: "calendar_list_calendars", args: {}, executionId: "e1" },
        context(),
      ),
    );
    expect(event).toEqual({
      type: "error",
      message: "Google access was revoked or expired. Reconnect Google Workspace in Integrations.",
    });
  });

  it("sends mail as an encoded message", async () => {
    const { prisma, secrets } = await setup({
      accessToken: "live",
      expiresAt: Date.now() + 3_600_000,
    });
    let sent: { raw: string } | undefined;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return json({ id: "m1" });
    });
    const connector = new GoogleWorkspaceConnector({ prisma, secrets, fetch });
    await collect(
      connector.execute(
        {
          tool: "gmail_send",
          args: { to: ["friend@example.test"], subject: "Hello বন্ধু", body: "Line one" },
          executionId: "e1",
        },
        context(),
      ),
    );
    const message = Buffer.from(sent!.raw, "base64url").toString("utf8");
    expect(message).toContain("To: friend@example.test");
    expect(message).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Hello বন্ধু").toString("base64")}?=`,
    );
    expect(message).toContain(Buffer.from("Line one").toString("base64"));
  });

  it("keeps the generic tools on Google API hosts", async () => {
    const { prisma, secrets } = await setup({
      accessToken: "live",
      expiresAt: Date.now() + 3_600_000,
    });
    const fetch = vi.fn(async () => json({}));
    const connector = new GoogleWorkspaceConnector({ prisma, secrets, fetch });
    const [event] = await collect(
      connector.execute(
        { tool: "google_api_get", args: { url: "https://evil.example.test/x" }, executionId: "e1" },
        context(),
      ),
    );
    expect(event).toEqual({
      type: "error",
      message: "url must be an https://…googleapis.com address",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
