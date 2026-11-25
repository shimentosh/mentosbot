import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { COMPUTER_ACCESS_PATH, newAccessToken } from "./access-keys.js";
import { mountComputerAccessMcp } from "./mcp-endpoint.js";

function appWithKey(options: { allowCommands: boolean }) {
  const { token, digest } = newAccessToken();
  const prisma = {
    computerAccessKey: {
      findUnique: vi.fn(async ({ where }: { where: { tokenDigest: string } }) =>
        where.tokenDigest === digest
          ? {
              id: "key_1",
              name: "Desk AI",
              botId: "bot_1",
              spaceId: "space_1",
              userId: "user_1",
              allowCommands: options.allowCommands,
              lastUsedAt: new Date(),
              bot: { archivedAt: null, userId: "user_1", spaceId: "space_1" },
              user: { email: "owner@example.test" },
            }
          : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    user: { findUnique: vi.fn(async () => ({ deactivatedAt: null })) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member_1" })) },
  };
  const app = new Hono();
  mountComputerAccessMcp(app, { prisma } as unknown as RouterDeps);
  return { app, token };
}

function rpc(app: Hono, token: string | undefined, body: unknown) {
  return app.request(COMPUTER_ACCESS_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("computer access MCP endpoint", () => {
  it("refuses a request whose key is unknown", async () => {
    const { app } = appWithKey({ allowCommands: false });
    const response = await rpc(app, newAccessToken().token, { jsonrpc: "2.0", id: 1 });
    expect(response.status).toBe(401);
  });

  it("lists run_command only for a key allowed to run commands", async () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const names = async (allowCommands: boolean) => {
      const { app, token } = appWithKey({ allowCommands });
      const response = await rpc(app, token, list);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      return body.result.tools.map((tool) => tool.name);
    };
    expect(await names(false)).not.toContain("run_command");
    expect(await names(true)).toContain("run_command");
  });

  it("refuses run_command from a key without that permission", async () => {
    const { app, token } = appWithKey({ allowCommands: false });
    const response = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "id" } },
    });
    const body = (await response.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });
});
