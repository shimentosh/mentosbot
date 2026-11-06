import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { UserComputerSession } from "./user-computer-projects.js";
import {
  checkUserComputerFolder,
  homeFolder,
  keptCommandOutput,
  listKeptCommands,
  listUserComputerFolders,
  localAppUrl,
  requestLocalApp,
  startKeptCommand,
  stopKeptCommand,
} from "./user-computer-projects.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/**
 * A device that runs each command here as the desktop app does: in a process group of its own
 * that is killed once the command ends, with HOME set to `home`.
 */
function localDevice(home: string, extraEnv: Record<string, string> = {}): UserDeviceGateway {
  return {
    connected: async () => ({ deviceId: "mac", name: "Mac", platform: process.platform }),
    pairedSince: async () => new Date(0),
    async *request<T>(_owner: string, request: HostComputerRequest) {
      if (request.method !== "execute") throw new Error(`unexpected ${request.method}`);
      const [file, ...args] = request.command.argv;
      const child = spawn(file!, args, {
        detached: true,
        cwd: request.command.cwd,
        env: { ...process.env, HOME: home, ...extraEnv, ...request.command.env },
      });
      const events: ProcessEvent[] = [];
      child.stdout.on("data", (data: Buffer) =>
        events.push({ type: "stdout", data: String(data) }),
      );
      child.stderr.on("data", (data: Buffer) =>
        events.push({ type: "stderr", data: String(data) }),
      );
      const code = await new Promise<number>((resolve) =>
        child.on("close", (c) => resolve(c ?? 1)),
      );
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group already ended.
      }
      for (const event of events) yield event as T;
      yield { type: "exit", code } as T;
    },
  };
}

const posix = process.platform === "win32" ? describe.skip : describe;

posix("project folders and kept commands on the user's computer", () => {
  let home: string;
  let session: UserComputerSession;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-home-")));
    session = {
      devices: localDevice(home, { RAKAZO_SETTLE: "1" }),
      owner: "user-1",
      deviceId: "mac",
      botId: "bot-1",
      environment: { platform: process.platform, home, shell: "/bin/sh" } as never,
      signal: new AbortController().signal,
    };
  });

  afterEach(async () => {
    for (const command of await listKeptCommands(session).catch(() => []))
      await stopKeptCommand(session, command.name).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  it("lists the folders in one folder, marks projects and leaves hidden ones out", async () => {
    await mkdir(path.join(home, "Code", "contentos-ui"), { recursive: true });
    await writeFile(path.join(home, "Code", "contentos-ui", "package.json"), "{}");
    await mkdir(path.join(home, "Code", "notes"));
    await mkdir(path.join(home, "Code", ".cache"));
    await mkdir(path.join(home, "Code", "it's mine"));
    const listing = await listUserComputerFolders(session, "~/Code");
    expect(listing).toMatchObject({ home, path: path.join(home, "Code"), parent: home });
    expect(listing.folders).toEqual([
      { name: "contentos-ui", project: true },
      { name: "it's mine", project: false },
      { name: "notes", project: false },
    ]);
    expect((await listUserComputerFolders(session)).parent).toBeNull();
    await expect(listUserComputerFolders(session, "/etc")).rejects.toThrow("home folder");
  });

  it("accepts only an existing folder inside the home, never the home itself", async () => {
    await mkdir(path.join(home, "app"));
    await expect(checkUserComputerFolder(session, "~/app")).resolves.toBe(path.join(home, "app"));
    await expect(checkUserComputerFolder(session, "~/gone")).rejects.toThrow("no folder");
    await expect(checkUserComputerFolder(session, "~")).rejects.toThrow("inside");
    expect(() => homeFolder(session.environment, "../elsewhere")).toThrow("home folder");
  });

  it("keeps a server running after the call, finds its port, reads its output and stops it", async () => {
    const port = await freePort();
    const folder = path.join(home, "app");
    await mkdir(folder);
    const command = `echo "listening on ${port}"; exec node -e "require('net').createServer().listen(${port}, '127.0.0.1')"`;
    const started = await startKeptCommand(session, { name: "dev-server", command, folder });
    expect(started).toMatchObject({ name: "dev-server", running: true, already: false });
    expect(started.output).toContain(`listening on ${port}`);

    await expect(
      startKeptCommand(session, { name: "dev-server", command, folder }),
    ).resolves.toMatchObject({ already: true });
    const [kept] = await listKeptCommands(session);
    expect(kept).toMatchObject({ name: "dev-server", running: true, folder, command });
    expect(kept?.ports).toEqual([port]);
    await expect(keptCommandOutput(session, "dev-server")).resolves.toContain("listening");

    await expect(stopKeptCommand(session, "dev-server")).resolves.toEqual({
      name: "dev-server",
      stopped: true,
    });
    expect((await listKeptCommands(session))[0]?.running ?? false).toBe(false);
    await expect(freePortIs(port)).resolves.toBe(true);
  });

  it("says when a command exits right away, and keeps its output", async () => {
    const started = await startKeptCommand(session, {
      name: "broken",
      command: "echo 'missing script' >&2; exit 1",
      folder: home,
    });
    expect(started).toMatchObject({ running: false });
    expect(started.output).toContain("missing script");
  });

  it("refuses names that are not plain words", async () => {
    await expect(
      startKeptCommand(session, { name: "../x", command: "true", folder: home }),
    ).rejects.toThrow("lowercase");
  });

  it("keeps each bot's commands apart", async () => {
    await startKeptCommand(session, { name: "sleeper", command: "sleep 30", folder: home });
    const other = { ...session, botId: "bot-2" };
    expect(await listKeptCommands(other)).toEqual([]);
    await expect(stopKeptCommand(other, "sleeper")).resolves.toMatchObject({ stopped: false });
    expect((await listKeptCommands(session))[0]?.running).toBe(true);
  });
});

posix("calling an app on the user's computer", () => {
  it("sends JSON to a local app and reads its answer back", async () => {
    const seen: Array<{ method?: string; url?: string; body: string; type?: string }> = [];
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body, type: req.headers["content-type"] });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "s1", ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const home = await realpath(tmpdir());
    const session = {
      devices: localDevice(home),
      owner: "user-1",
      deviceId: "mac",
      botId: "bot-1",
      environment: { platform: process.platform, home, shell: "/bin/sh" } as never,
      signal: new AbortController().signal,
    };
    try {
      await expect(
        requestLocalApp(session, {
          method: "post",
          url: `http://127.0.0.1:${port}/api/agent`,
          body: { page: "shimanto", prompt: "it's a test" },
        }),
      ).resolves.toEqual({ status: 200, body: { id: "s1", ok: true } });
      expect(seen).toEqual([
        {
          method: "POST",
          url: "/api/agent",
          body: JSON.stringify({ page: "shimanto", prompt: "it's a test" }),
          type: "application/json",
        },
      ]);
      await expect(
        requestLocalApp(session, { url: `http://localhost:${port}/api/agent?page=x` }),
      ).resolves.toMatchObject({ status: 200 });
      expect(seen[1]).toMatchObject({ method: "GET", url: "/api/agent?page=x", body: "" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const closed = await freePort();
    await expect(requestLocalApp(session, { url: `http://127.0.0.1:${closed}/` })).rejects.toThrow(
      "Nothing answered",
    );
  });

  it("only calls apps on the computer itself", () => {
    expect(localAppUrl("http://127.0.0.1:3000/api")).toBe("http://127.0.0.1:3000/api");
    expect(localAppUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    for (const url of [
      "https://127.0.0.1:3000/",
      "http://example.com/",
      "http://10.0.0.2:3000/",
      "http://user:pass@127.0.0.1/",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(() => localAppUrl(url), url).toThrow();
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function freePortIs(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
