import { runAsTenant } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "../http/http-body.js";
import type { RouterDeps } from "../router.js";
import type { AccessGrant } from "./access-keys.js";
import { COMPUTER_ACCESS_PATH, resolveAccessToken } from "./access-keys.js";
import { computerAccessTools } from "./computer-access.tool-definition.js";
import { createComputerAccessTools } from "./computer-access-tools.js";

/** A write_file of the largest text file, encoded as JSON, fits with room to spare. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}

function unauthorized(c: Context) {
  c.header("WWW-Authenticate", 'Bearer realm="rakazo-computer"');
  return c.json({ error: "Unauthorized" }, 401);
}

/**
 * The MCP endpoint outside AIs use to control a bot's computer. It keeps no session: every
 * request carries its key, so any API instance answers any call.
 */
export function mountComputerAccessMcp(app: Hono, deps: RouterDeps) {
  app.post(COMPUTER_ACCESS_PATH, async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return unauthorized(c);
    const grant = await resolveAccessToken(deps.prisma, token);
    if (!grant) return unauthorized(c);
    const raw = await readBoundedBody(c.req.raw, MAX_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    return runAsTenant(grant.actor, () => answer(deps, grant, c.req.raw, body));
  });
  // Without sessions there is no stream to open or close.
  app.on(["GET", "DELETE"], COMPUTER_ACCESS_PATH, async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !(await resolveAccessToken(deps.prisma, token))) return unauthorized(c);
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

async function answer(
  deps: RouterDeps,
  grant: AccessGrant,
  request: Request,
  body: unknown,
): Promise<Response> {
  // Loaded on the first call, so servers nobody connects to never load the protocol library.
  const [{ Server }, { WebStandardStreamableHTTPServerTransport }, protocol] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const server = new Server(
    { name: "rakazo-computer", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const tools = createComputerAccessTools(deps, grant);
  server.setRequestHandler(protocol.ListToolsRequestSchema, async () => ({
    tools: computerAccessTools({ allowCommands: grant.allowCommands }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
    })),
  }));
  server.setRequestHandler(protocol.CallToolRequestSchema, async (call) =>
    tools.call(call.params.name, call.params.arguments ?? {}),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }
}
