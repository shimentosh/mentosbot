import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  userComputerAgent,
  userComputerAttach,
  userComputerAttachScript,
  userComputerCwd,
  userComputerFolder,
  userComputerGate,
  userComputerOwner,
  userComputerShell,
} from "./run-tools-user-computer.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const attached = vi.hoisted(() => ({
  calls: [] as Array<{ filePath: string; bytes: Uint8Array }>,
}));
vi.mock("./thread-artifacts.js", () => ({
  attachWorkspaceFileToThread: vi.fn(
    async (_deps: unknown, input: { filePath: string; bytes: Uint8Array }) => {
      attached.calls.push(input);
      return { artifactId: "artifact-1", block: { kind: "file" } };
    },
  ),
}));
vi.mock("./run-messages.js", () => ({ publishMessage: vi.fn(async () => undefined) }));

const environment = { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" };

type Folder = { deviceId: string; path: string };

function setup(
  execute: (signal: AbortSignal) => AsyncIterable<unknown>,
  secrets: string[] = [],
  folder?: Folder,
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
    connected: async () => ({ deviceId: "device-1", name: "Laptop", platform: "darwin" }),
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
      userComputerGate(ctx, false, "user_computer_observe", { app: "mail" }),
    ).resolves.toBe("allow");
    expect(findMany).toHaveBeenCalledTimes(3);
    await expect(
      userComputerGate(ctx, false, "user_computer_observe", { app: "Notes" }),
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
      await expect(userComputerGate(ctx, false, name, {})).resolves.toBe("allow");
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
  };

  it("is the bot owner when their own message started the run", () => {
    expect(userComputerOwner(own)).toBe("user-1");
    expect(userComputerOwner({ ...own, trigger: "follow_up" })).toBe("user-1");
    // A bot shared with teammates never reaches its owner's own computer.
    expect(userComputerOwner({ ...own, sharedWithTeammates: true })).toBeUndefined();
  });

  it.each([
    { trigger: "routine" },
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

  it("returns a quiet long-running command early and keeps collecting its output", async () => {
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.useFakeTimers();
    try {
      const { ctx, call, onShellStillRunning } = setup(async function* () {
        yield { type: "stdout", data: "Enter code ABCD\n" };
        await exited;
        yield { type: "exit", code: 0 };
      });
      const pending = userComputerShell(ctx, call({ command: "gh auth login" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({ stdout: "Enter code ABCD\n", running: true });
      expect(onShellStillRunning).toHaveBeenCalledOnce();
      finish();
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
    expect(check.command.env).toEqual({ RAKAZO_PROJECT_FOLDER: "/Users/fake/Projects/it's mine" });
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
