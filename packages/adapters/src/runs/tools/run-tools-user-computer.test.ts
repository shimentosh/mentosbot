import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "../../computers/host/host-computer-protocol.js";
import type { UserDeviceGateway } from "../../computers/host/user-device-protocol.js";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  botMessageFromOwnersWork,
  userComputerAct,
  userComputerAgent,
  userComputerAttach,
  userComputerAttachScript,
  userComputerCwd,
  userComputerFolder,
  userComputerGate,
  userComputerList,
  userComputerObserve,
  userComputerOwner,
  userComputerShell,
} from "./run-tools-user-computer.js";

const attached = vi.hoisted(() => ({
  calls: [] as Array<{ filePath: string; bytes: Uint8Array }>,
}));
vi.mock("../../storage/thread-artifacts.js", () => ({
  attachWorkspaceFileToThread: vi.fn(
    async (_deps: unknown, input: { filePath: string; bytes: Uint8Array }) => {
      attached.calls.push(input);
      return { artifactId: "artifact-1", block: { kind: "file" } };
    },
  ),
}));
vi.mock("../assembly/run-messages.js", () => ({ publishMessage: vi.fn(async () => undefined) }));

const environment = { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" };

type Folder = { deviceId: string; path: string };

function setup(
  execute: (signal: AbortSignal) => AsyncIterable<unknown>,
  secrets: string[] = [],
  folder?: Folder,
  /** Connected computers, the latest first. */
  connectedDevices = ["device-1"],
  /** The connected computer someone is using, which the gateway lists first. */
  inUse?: string,
) {
  const controller = new AbortController();
  const botFolder = {
    findUnique: vi.fn(async () => folder ?? null),
    upsert: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const requests: HostComputerRequest[] = [];
  const signals: AbortSignal[] = [];
  const deviceIds: (string | undefined)[] = [];
  const gateway: UserDeviceGateway = {
    list: async () => [],
    connected: async (_userId, deviceId) => {
      const found = deviceId
        ? connectedDevices.find((id) => id === deviceId)
        : (inUse ?? connectedDevices[0]);
      return found
        ? {
            deviceId: found,
            name: "Laptop",
            platform: "darwin",
            activeAt: found === inUse ? new Date() : null,
          }
        : null;
    },
    pairedSince: async () => new Date(0),
    async *request<T>(
      _userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      requests.push(request);
      deviceIds.push(deviceId);
      signals.push(signal);
      if (request.method === "provision") yield {} as T;
      else if (request.method === "environment") yield environment as T;
      else yield* execute(signal) as AsyncIterable<T>;
    },
  };
  const ctx = {
    deps: {
      userDevices: gateway,
      prisma: { botFolder },
      artifacts: {},
      maxUploadSizeBytes: 1024 * 1024,
    },
    bot: { id: "bot-1" },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1" },
    thread: { groupId: null },
    runId: "run-1",
    source: { userComputerOwner: "user-1" },
    context: { signal: controller.signal },
    secrets,
  } as unknown as RunContext;
  const onShellStillRunning = vi.fn();
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_shell",
      args,
      observer: { onShellStillRunning },
      executionId: "call-1",
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, controller, requests, signals, deviceIds, onShellStillRunning, botFolder };
}

describe("userComputerGate", () => {
  it("finds an app approved before hundreds of later screen actions", async () => {
    const effects = [
      ...Array.from({ length: 450 }, (_, index) => ({ id: `e${450 - index}`, app: "TextEdit" })),
      { id: "e0", app: "Mail" },
    ].map(({ id, app }) => ({ id, request: { app } }));
    const findMany = vi.fn(async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
      const start = cursor ? effects.findIndex((effect) => effect.id === cursor.id) + 1 : 0;
      return effects.slice(start, start + take);
    });
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "mail" }, "ask"),
    ).resolves.toBe("allow");
    expect(findMany).toHaveBeenCalledTimes(3);
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "Notes" }, "ask"),
    ).resolves.toBe("ask");
  });
});

describe("userComputerGate for commands", () => {
  it.each([
    ["user_computer_shell", "user_computer_shell"],
    ["user_computer_agent", { in: ["user_computer_shell", "user_computer_agent"] }],
    ["user_computer_folder", { in: ["user_computer_shell", "user_computer_folder"] }],
  ])(
    "lets an approved shell cover %s, and only its own approval cover itself",
    async (name, kind) => {
      const findFirst = vi.fn(async () => ({ id: "effect-1" }));
      const ctx = {
        deps: {
          userDevices: { pairedSince: async () => new Date(0) },
          prisma: { externalEffect: { findFirst } },
        },
        run: { spaceId: "space-1", userId: "user-1" },
      } as unknown as RunContext;
      await expect(userComputerGate(ctx, false, name, {}, "ask")).resolves.toBe("allow");
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ kind }) }),
      );
    },
  );
});

describe("userComputerOwner", () => {
  const own = {
    trigger: "user",
    sourceRole: "user",
    messagingChannelRun: false,
    runUserId: "user-1",
    botUserId: "user-1",
    ownerComputerRoutine: false,
  };
  const ownRoutine = {
    ...own,
    trigger: "routine",
    sourceRole: undefined,
    ownerComputerRoutine: true,
  };

  it("is the bot owner when their own message or a routine they let use it started the run", () => {
    expect(userComputerOwner(own)).toBe("user-1");
    expect(userComputerOwner({ ...own, trigger: "follow_up" })).toBe("user-1");
    // A bot shared with teammates never reaches its owner's own computer.
    expect(userComputerOwner({ ...own, sharedWithTeammates: true })).toBeUndefined();
    expect(userComputerOwner(ownRoutine)).toBe("user-1");
  });

  it.each([
    { ownerComputerRoutine: false },
    { runUserId: "user-2" },
    { botUserId: "user-2" },
    { messagingChannelRun: true },
    { sharedWithTeammates: true },
  ])("is nobody for a routine run with %o", (change) => {
    expect(userComputerOwner({ ...ownRoutine, ...change })).toBeUndefined();
  });

  it.each([
    { trigger: "routine" },
    // Only a routine run counts, never an event run that claims the routine's permission.
    { trigger: "webhook", ownerComputerRoutine: true },
    { trigger: "webhook" },
    { trigger: "messaging" },
    { trigger: "call_end" },
    { sourceRole: "bot" },
    { sourceRole: undefined },
    { messagingChannelRun: true },
    { runUserId: "user-2" },
  ])("is nobody for %o", (change) => {
    expect(userComputerOwner({ ...own, ...change })).toBeUndefined();
  });
});

describe("userComputerCwd", () => {
  it("defaults to home and resolves relative and ~ paths against it", () => {
    expect(userComputerCwd(environment, undefined)).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~")).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "/Users/fake/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "..cache")).toBe("/Users/fake/..cache");
    expect(() => userComputerCwd(environment, "/tmp")).toThrow("inside the user's home folder");
    expect(() => userComputerCwd(environment, "../other")).toThrow("inside the user's home folder");
    expect(
      userComputerCwd({ platform: "win32", home: "C:\\Users\\fake", shell: "pwsh" }, "code"),
    ).toBe("C:\\Users\\fake\\code");
  });

  it("starts from the project folder when there is one", () => {
    const folder = "/Users/fake/Projects/site";
    expect(userComputerCwd(environment, undefined, folder)).toBe(folder);
    expect(userComputerCwd(environment, "src", folder)).toBe(`${folder}/src`);
    expect(userComputerCwd(environment, "~", folder)).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~/notes", folder)).toBe("/Users/fake/notes");
    expect(() => userComputerCwd(environment, "../../..", folder)).toThrow(
      "inside the user's home folder",
    );
  });

  it("works in a folder the person picked outside the home, and nowhere else there", () => {
    const windows = {
      platform: "win32",
      home: "C:\\Users\\fake",
      shell: "pwsh",
      roots: ["J:\\projects"],
    };
    const folder = "J:\\projects\\site";
    expect(userComputerCwd(windows, undefined, folder)).toBe(folder);
    expect(userComputerCwd(windows, "src", folder)).toBe("J:\\projects\\site\\src");
    expect(userComputerCwd(windows, "j:\\Projects\\other")).toBe("j:\\Projects\\other");
    expect(() => userComputerCwd(windows, "J:\\elsewhere")).toThrow("one they picked");
    expect(() => userComputerCwd(windows, "..\\..", folder)).toThrow("one they picked");
  });
});

describe("userComputerShell", () => {
  it("streams the command's redacted output from the user's shell", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      async function* () {
        yield { type: "stdout", data: "token=sk-fake-secret\n" };
        yield { type: "stderr", data: "warning\n" };
        yield { type: "exit", code: 2 };
      },
      ["sk-fake-secret"],
    );
    const result = (await userComputerShell(ctx, call({ command: "cat .env", cwd: "app" }))) as {
      stdout: string;
      stderr: string;
      code: number;
    };
    expect(result.stdout).not.toContain("sk-fake-secret");
    expect(result).toMatchObject({ stderr: "warning\n", code: 2 });
    expect(deviceIds).toEqual(["device-1", "device-1", "device-1"]);
    expect(requests).toEqual([
      { method: "provision", botId: "bot-1", runId: "run-1" },
      { method: "environment", botId: "bot-1", runId: "run-1" },
      {
        method: "execute",
        botId: "bot-1",
        runId: "run-1",
        command: expect.objectContaining({
          argv: ["/bin/zsh", "-lc", "cat .env"],
          cwd: "/Users/fake/app",
        }),
      },
    ]);
  });

  it("returns a quiet sign-in prompt early and keeps collecting its output", async () => {
    const exited = deferred();
    vi.useFakeTimers();
    try {
      const { ctx, call, onShellStillRunning } = setup(async function* () {
        yield { type: "stdout", data: "Enter code ABCD-1234 at https://example.com/device\n" };
        await exited.promise;
        yield { type: "exit", code: 0 };
      });
      const pending = userComputerShell(ctx, call({ command: "gh auth login" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({
        stdout: "Enter code ABCD-1234 at https://example.com/device\n",
        running: true,
      });
      expect(onShellStillRunning).toHaveBeenCalledOnce();
      exited.resolve();
      await expect(onShellStillRunning.mock.calls[0]![0]).resolves.toMatchObject({ code: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a device that drops mid-command as an error result", async () => {
    const { ctx, call } = setup(async function* () {
      yield* [];
      throw new Error("Device disconnected");
    });
    expect(await userComputerShell(ctx, call({ command: "ls" }))).toEqual({
      error: "The user's computer did not finish the command: Device disconnected",
    });
  });

  it("passes the run's abort to the device and rethrows it", async () => {
    const { ctx, call, controller, signals } = setup(async function* (signal) {
      yield* [];
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    });
    const pending = userComputerShell(ctx, call({ command: "sleep 100" }));
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("userComputerShell with a project folder", () => {
  const exit = async function* () {
    yield { type: "exit", code: 0 };
  };

  it("runs in the folder on the connected computer", async () => {
    const { ctx, call, requests } = setup(exit, [], {
      deviceId: "device-1",
      path: "/Users/fake/Projects/site",
    });
    await userComputerShell(ctx, call({ command: "ls" }));
    expect(requests.at(-1)).toMatchObject({ command: { cwd: "/Users/fake/Projects/site" } });
  });

  it("ignores a folder on another computer", async () => {
    const { ctx, call, requests } = setup(exit, [], {
      deviceId: "device-2",
      path: "/Users/fake/Projects/site",
    });
    await userComputerShell(ctx, call({ command: "ls" }));
    expect(requests.at(-1)).toMatchObject({ command: { cwd: "/Users/fake" } });
  });

  it("runs on the computer holding the folder when another connected later", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      exit,
      [],
      { deviceId: "device-2", path: "/Users/fake/Projects/site" },
      ["device-1", "device-2"],
    );
    await userComputerShell(ctx, call({ command: "ls" }));
    expect(new Set(deviceIds)).toEqual(new Set(["device-2"]));
    expect(requests.at(-1)).toMatchObject({ command: { cwd: "/Users/fake/Projects/site" } });
  });

  it("runs on the computer the person is using, ahead of the one holding the folder", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      exit,
      [],
      { deviceId: "device-2", path: "/Users/fake/Projects/site" },
      ["device-1", "device-2"],
      "device-1",
    );
    await userComputerShell(ctx, call({ command: "ls" }));
    expect(new Set(deviceIds)).toEqual(new Set(["device-1"]));
    // The folder is on the other computer, so the command starts in the home folder.
    expect(requests.at(-1)).toMatchObject({ command: { cwd: "/Users/fake" } });
  });
});

describe("userComputerFolder", () => {
  const exitWith = (code: number) =>
    async function* () {
      yield { type: "exit", code };
    };

  it("saves a folder found on the connected computer, passing its path as a variable", async () => {
    const { ctx, call, requests, botFolder } = setup(exitWith(0));
    const result = await userComputerFolder(ctx, call({ path: "~/Projects/it's mine" }));
    expect(result).toEqual({ ok: true, folder: "/Users/fake/Projects/it's mine" });
    const check = requests.at(-1) as Extract<HostComputerRequest, { method: "execute" }>;
    expect(check.command.env).toEqual({ RAKAZO_PATH: "/Users/fake/Projects/it's mine" });
    expect(check.command.argv.join(" ")).not.toContain("it's mine");
    expect(botFolder.upsert).toHaveBeenCalledWith({
      where: { botId_userId: { botId: "bot-1", userId: "user-1" } },
      create: {
        botId: "bot-1",
        userId: "user-1",
        spaceId: "space-1",
        deviceId: "device-1",
        path: "/Users/fake/Projects/it's mine",
      },
      update: { deviceId: "device-1", path: "/Users/fake/Projects/it's mine" },
    });
  });

  it("refuses a folder that is not there", async () => {
    const { ctx, call, botFolder } = setup(exitWith(1));
    expect(await userComputerFolder(ctx, call({ path: "~/missing" }))).toEqual({
      error: "There is no folder at /Users/fake/missing on the user's computer.",
    });
    expect(botFolder.upsert).not.toHaveBeenCalled();
  });

  it.each(["/tmp", "~", "~/"])("refuses %s without asking the computer", async (path) => {
    const { ctx, call, requests, botFolder } = setup(exitWith(0));
    const result = (await userComputerFolder(ctx, call({ path }))) as { error: string };
    expect(result.error).toMatch(/inside the user's home folder/);
    expect(requests.some((request) => request.method === "execute")).toBe(false);
    expect(botFolder.upsert).not.toHaveBeenCalled();
  });

  it("clears the folder for an empty path", async () => {
    const { ctx, call, requests, botFolder } = setup(exitWith(0));
    expect(await userComputerFolder(ctx, call({ path: " " }))).toEqual({ ok: true, folder: null });
    expect(botFolder.deleteMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", userId: "user-1" },
    });
    expect(requests).toEqual([]);
  });
});

describe("userComputerAgent", () => {
  const folder = { deviceId: "device-1", path: "/Users/fake/Projects/site" };
  const agentOutput = (...lines: unknown[]) =>
    async function* () {
      yield {
        type: "stdout",
        data: `rakazo-coding-agent 0\n${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      };
      yield { type: "exit", code: 0 };
    };

  it("runs the agent in the project folder and returns its answer and session", async () => {
    const { ctx, call, requests } = setup(
      agentOutput(
        {
          type: "assistant",
          session_id: "s-1",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
        },
        { type: "result", session_id: "s-1", is_error: false, result: "Done: token=sk-fake" },
      ),
      ["sk-fake"],
      folder,
    );
    const result = await userComputerAgent(ctx, call({ task: "make the video", session: "s-0" }));
    expect(result).toEqual({
      result: "Done: token=[redacted]",
      session: "s-1",
      steps: ["Bash: ls"],
    });
    const run = requests.at(-1) as Extract<HostComputerRequest, { method: "execute" }>;
    expect(run.command).toMatchObject({
      cwd: "/Users/fake/Projects/site",
      env: { RAKAZO_AGENT_TASK: "make the video", RAKAZO_AGENT_SESSION: "s-0" },
      timeoutMs: 60 * 60_000,
    });
    expect(run.command.argv.join(" ")).not.toContain("make the video");
  });

  it("needs a project folder on the connected computer", async () => {
    const { ctx, call, requests } = setup(agentOutput(), [], { ...folder, deviceId: "device-2" });
    expect(await userComputerAgent(ctx, call({ task: "build" }))).toEqual({
      error: "Set your project folder on the user's computer first with user_computer_folder.",
    });
    expect(requests).toEqual([]);
  });

  it("says when no coding agent is installed", async () => {
    const { ctx, call } = setup(
      async function* () {
        yield { type: "exit", code: 127 };
      },
      [],
      folder,
    );
    expect(await userComputerAgent(ctx, call({ task: "build" }))).toMatchObject({
      error: expect.stringContaining("No coding agent is installed"),
    });
  });

  it("reports an agent that stopped without an answer, with its error output", async () => {
    const { ctx, call } = setup(
      async function* () {
        yield { type: "stdout", data: "rakazo-coding-agent 0\n" };
        yield { type: "stderr", data: "Not signed in\n" };
        yield { type: "exit", code: 1 };
      },
      [],
      folder,
    );
    expect(await userComputerAgent(ctx, call({ task: "build" }))).toEqual({
      error: "The coding agent stopped without an answer (exit code 1).",
      output: "Not signed in",
      steps: [],
    });
  });
});

describe("userComputerAttachScript", () => {
  it.skipIf(process.platform === "win32")(
    "prints the file as base64 and refuses a missing or oversized file",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "attach-"));
      try {
        const file = join(directory, "it's a clip $(x).mp4");
        const bytes = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 256));
        writeFileSync(file, bytes);
        const run = (path: string, max: number) =>
          spawnSync("/bin/sh", ["-c", userComputerAttachScript({ platform: "darwin" })], {
            encoding: "utf8",
            env: {
              PATH: "/usr/bin:/bin",
              RAKAZO_ATTACH_FILE: path,
              RAKAZO_ATTACH_MAX: String(max),
            },
          });
        const sent = run(file, 3000);
        expect(sent.status).toBe(0);
        expect(Buffer.from(sent.stdout, "base64").equals(bytes)).toBe(true);
        expect(run(file, 2999).status).toBe(65);
        expect(run(join(directory, "missing.mp4"), 3000).status).toBe(66);
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  );
});

describe("userComputerAttach", () => {
  const folder = { deviceId: "device-1", path: "/Users/fake/Projects/site" };

  it("sends a file from the project folder to the chat", async () => {
    attached.calls.length = 0;
    const content = Buffer.from("fake video bytes");
    const encoded = content.toString("base64");
    const { ctx, call, requests } = setup(
      async function* () {
        yield { type: "stdout", data: `${encoded.slice(0, 5)}\n` };
        yield { type: "stdout", data: encoded.slice(5) };
        yield { type: "exit", code: 0 };
      },
      [],
      folder,
    );
    expect(await userComputerAttach(ctx, call({ path: "renders/reel.mp4" }))).toEqual({
      ok: true,
      artifactId: "artifact-1",
      path: "/Users/fake/Projects/site/renders/reel.mp4",
    });
    const run = requests.at(-1) as Extract<HostComputerRequest, { method: "execute" }>;
    expect(run.command.env).toEqual({
      RAKAZO_ATTACH_FILE: "/Users/fake/Projects/site/renders/reel.mp4",
      RAKAZO_ATTACH_MAX: "1048576",
    });
    expect(Buffer.from(attached.calls[0]!.bytes).equals(content)).toBe(true);
  });

  it.each([
    [66, "There is no file at /Users/fake/clip.mp4 on the user's computer."],
    [65, "/Users/fake/clip.mp4 is larger than the 1 MiB attachment limit."],
  ])("explains exit %i", async (code, error) => {
    const { ctx, call } = setup(async function* () {
      yield { type: "exit", code };
    });
    expect(await userComputerAttach(ctx, call({ path: "~/clip.mp4" }))).toEqual({ error });
  });

  it("refuses a type the chat cannot show without asking the computer", async () => {
    const { ctx, call, requests } = setup(async function* () {
      yield { type: "exit", code: 0 };
    });
    expect(await userComputerAttach(ctx, call({ path: "~/tool.exe" }))).toMatchObject({
      error: "unsupported attachment type",
    });
    expect(requests).toEqual([]);
  });
});

describe("botMessageFromOwnersWork", () => {
  type Run = {
    trigger: string;
    userId: string;
    sourceMessageId: string | null;
    bot: { id: string; userId: string };
    sourceMessage: { role: string; authorUserId: string | null } | null;
  };
  /** Bot messages as rows: inbound (in the target's chat) points back at the sender's outbound. */
  function world(runs: Record<string, Run>, shared: string[] = []) {
    const messages: Record<string, { blocks?: unknown; runId?: string }> = {};
    for (const [id] of Object.entries(runs)) {
      messages[`out-${id}`] = { runId: id };
      messages[`in-from-${id}`] = {
        blocks: [{ kind: "bot_message_received", returnToMessageId: `out-${id}` }],
      };
    }
    return {
      message: {
        findUnique: async ({ where }: { where: { id: string } }) => messages[where.id] ?? null,
      },
      run: { findUnique: async ({ where }: { where: { id: string } }) => runs[where.id] ?? null },
      botAccess: {
        count: async ({ where }: { where: { botId: string } }) =>
          shared.includes(where.botId) ? 1 : 0,
      },
    } as unknown as Parameters<typeof botMessageFromOwnersWork>[0];
  }
  const ownersMessage: Run = {
    trigger: "user",
    userId: "ada",
    sourceMessageId: "m1",
    bot: { id: "social", userId: "ada" },
    sourceMessage: { role: "user", authorUserId: null },
  };

  it("follows a handoff back to the owner's own message", async () => {
    expect(await botMessageFromOwnersWork(world({ a: ownersMessage }), "in-from-a")).toBe(true);
    // Social hands to Scout, which hands on: still the owner's work.
    const relay = { ...ownersMessage, trigger: "bot_message", sourceMessageId: "in-from-a" };
    expect(await botMessageFromOwnersWork(world({ a: ownersMessage, b: relay }), "in-from-b")).toBe(
      true,
    );
  });

  it("never follows work a routine, channel, webhook, teammate or shared bot began", async () => {
    for (const sender of [
      { ...ownersMessage, trigger: "routine", sourceMessage: null },
      { ...ownersMessage, trigger: "messaging" },
      { ...ownersMessage, trigger: "webhook", sourceMessage: null },
      { ...ownersMessage, sourceMessage: { role: "user", authorUserId: "grace" } },
      { ...ownersMessage, userId: "grace" },
    ])
      expect(await botMessageFromOwnersWork(world({ a: sender }), "in-from-a")).toBe(false);
    expect(
      await botMessageFromOwnersWork(world({ a: ownersMessage }, ["social"]), "in-from-a"),
    ).toBe(false);
    expect(await botMessageFromOwnersWork(world({}), "in-from-a")).toBe(false);
    expect(await botMessageFromOwnersWork(world({ a: ownersMessage }), null)).toBe(false);
  });

  it("stops following a loop of bots handing work to each other", async () => {
    const loop = { ...ownersMessage, trigger: "bot_message", sourceMessageId: "in-from-a" };
    expect(await botMessageFromOwnersWork(world({ a: loop }), "in-from-a")).toBe(false);
  });
});

describe("explicit computer targeting", () => {
  it("pins every shell request to the selected computer", async () => {
    const { ctx, call, deviceIds } = setup(async function* () {
      yield { type: "exit", code: 0 };
    });
    const connected = vi.fn(async (_owner: string, id?: string) => ({
      deviceId: id ?? "device-1",
      name: "Desk PC",
      platform: "linux",
      activeAt: null,
    }));
    ctx.deps.userDevices!.connected = connected;
    await userComputerShell(ctx, call({ command: "pwd", computerId: "device-2" }));
    expect(connected).toHaveBeenCalledWith("user-1", "device-2");
    expect(deviceIds).toEqual(["device-2", "device-2", "device-2"]);
  });

  it.each([userComputerObserve, userComputerAct])(
    "pins screen requests to the selected computer",
    async (tool) => {
      const { ctx, call, deviceIds } = setup(async function* () {
        yield { app: "Notes", tree: "Window", completed: 1 };
      });
      ctx.computer = { acceptsImages: false } as RunContext["computer"];
      ctx.deps.userDevices!.connected = vi.fn(async (_owner, id) => ({
        deviceId: id!,
        name: "Desk PC",
        platform: "darwin",
        activeAt: null,
      }));
      await tool(
        ctx,
        call({ app: "Notes", actions: [{ kind: "wait", ms: 1 }], computerId: "device-2" }),
      );
      expect(deviceIds).toEqual(["device-2"]);
    },
  );

  it.each([userComputerShell, userComputerObserve, userComputerAct])(
    "refuses unavailable targets without requests",
    async (tool) => {
      const { ctx, call, requests } = setup(async function* () {});
      ctx.deps.userDevices!.connected = vi.fn(async () => null);
      const result = await tool(
        ctx,
        call({
          command: "pwd",
          app: "Notes",
          actions: [{ kind: "wait", ms: 1 }],
          computerId: "missing",
        }),
      );
      expect(result).toMatchObject({ error: expect.stringContaining("selected computer") });
      expect(requests).toEqual([]);
    },
  );

  it.each(["", null, 42])(
    "rejects malformed ids (%s) instead of using the default",
    async (computerId) => {
      const { ctx, call, requests } = setup(async function* () {});
      expect(await userComputerShell(ctx, call({ command: "pwd", computerId }))).toMatchObject({
        error: expect.stringContaining("computerId"),
      });
      expect(requests).toEqual([]);
    },
  );

  it("lists only the owner's connected computers, with the omitted-id binding", async () => {
    const { ctx, call } = setup(async function* () {});
    ctx.deps.userDevices!.list = vi.fn(async () => [
      { deviceId: "d1", name: "Laptop", connected: true, routeTraffic: false, bound: false },
      { deviceId: "d2", name: "Desk PC", connected: true, routeTraffic: false, bound: true },
      { deviceId: "d3", name: "Offline PC", connected: false, routeTraffic: false },
    ]);
    expect(await userComputerList(ctx, call({}))).toEqual({
      computers: [
        { computerId: "d1", name: "Laptop", bound: false },
        { computerId: "d2", name: "Desk PC", bound: true },
      ],
    });
    expect(ctx.deps.userDevices!.list).toHaveBeenCalledWith("user-1");
    ctx.source.userComputerOwner = undefined;
    expect(await userComputerList(ctx, call({}))).toHaveProperty("error");
  });
});
