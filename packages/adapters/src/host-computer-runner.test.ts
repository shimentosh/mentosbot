import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostComputerFrame } from "./host-computer-protocol.js";
import { createHostComputerRunner } from "./host-computer-runner.js";

let root: string;
let home: string;
let picked: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rakazo-runner-test-"));
  // A home of its own, so the picked folder is outside it on every system.
  home = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-home-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  picked = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-picked-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [root, home, picked]) await rm(dir, { recursive: true, force: true });
});

async function send(pickedFolders: string[], input: unknown) {
  const runner = createHostComputerRunner({ root, pickedFolders: () => pickedFolders });
  runner.setEnabled(true);
  const call = runner.begin()!;
  const frames: HostComputerFrame<unknown>[] = [];
  try {
    await call.run(input, { open: () => undefined, write: (frame) => void frames.push(frame) });
    return frames.flatMap((frame) => ("value" in frame ? [frame.value] : []));
  } finally {
    call.end();
    runner.close();
  }
}

const execute = (cwd: string) => ({
  method: "execute",
  botId: "bot-1",
  command: { argv: [process.execPath, "-e", "console.log(process.cwd())"], cwd },
});

it("reports the folders the person picked and runs commands in them, not elsewhere", async () => {
  await send([picked], { method: "provision", botId: "bot-1" });
  await expect(send([picked], { method: "environment", botId: "bot-1" })).resolves.toEqual([
    expect.objectContaining({ roots: [picked] }),
  ]);
  const inside = await send([picked], execute(picked));
  expect(inside.at(-1)).toEqual({ type: "exit", code: 0 });
  const outside = await send([], execute(picked));
  expect(outside).toEqual([
    { type: "stderr", data: "path is outside this computer's home" },
    { type: "exit", code: 1 },
  ]);
});
