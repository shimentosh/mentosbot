import { describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

describe("owner words", () => {
  const ownerWords = (trigger: string, blocks: unknown[], role = "user") =>
    createRunTrustLoaders({} as ExecutorDeps, {
      run: { userId: "user-1", spaceId: "space-1", trigger },
      runId: "run-1",
      botId: "bot-1",
      taskPrompt: "prompt",
      ownerStartedRun: trigger === "user",
      messagingChannelRun: false,
      sourceMessage: { role, blocks },
      connectedPlugins: [],
    }).loadOwnerWords();

  const delivery = (fields: Record<string, unknown>) => [
    {
      kind: "bot_message_received",
      fromBotId: "bot-2",
      fromBotName: "Manager",
      text: "do it",
      ...fields,
    },
  ];

  it("reads the person's request a teammate's delivery carries", async () => {
    await expect(
      ownerWords("bot_message", delivery({ userRequest: "publish the post" })),
    ).resolves.toBe("publish the post");
  });

  it("never takes a teammate's own message as the person's words", async () => {
    await expect(ownerWords("bot_message", delivery({}))).resolves.toBe("");
  });
});
