import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgentCli } from "./coding-agent-cli.js";
import {
  AGENT_SESSION,
  AGENT_SESSION_VARIABLE,
  AGENT_TASK,
  AGENT_TASK_VARIABLE,
  codingAgentReader,
  codingAgentScript,
  NO_CODING_AGENT_EXIT,
} from "./coding-agent-cli.js";
import { claudeCodeCli } from "./coding-agent-cli-claude-code.js";

const fakeCli = (command: string): CodingAgentCli => ({
  command,
  args: (resume) => ["run", AGENT_TASK, ...(resume ? (["--resume", AGENT_SESSION] as const) : [])],
  read(line, outcome) {
    outcome.result = line;
  },
});

const task = "say it's $HOME `whoami` $(echo hi); done";

describe("codingAgentScript", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function run(script: string, path: string, session?: string) {
    return spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${path}:/usr/bin:/bin`,
        [AGENT_TASK_VARIABLE]: task,
        ...(session ? { [AGENT_SESSION_VARIABLE]: session } : {}),
      },
    });
  }

  it.skipIf(process.platform === "win32")(
    "runs the first installed agent with the task as one literal argument",
    () => {
      const bin = mkdtempSync(join(tmpdir(), "coding-agent-"));
      directories.push(bin);
      const agent = join(bin, "second-agent");
      writeFileSync(agent, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n');
      chmodSync(agent, 0o755);
      const clis = [fakeCli("missing-agent"), fakeCli("second-agent")];

      const fresh = run(codingAgentScript({ platform: "darwin" }, false, clis), bin);
      expect(fresh.status).toBe(0);
      expect(fresh.stdout).toBe(`rakazo-coding-agent 1\nrun\n${task}\n`);

      const resumed = run(codingAgentScript({ platform: "darwin" }, true, clis), bin, "s-1");
      expect(resumed.stdout).toBe(`rakazo-coding-agent 1\nrun\n${task}\n--resume\ns-1\n`);

      const none = run(codingAgentScript({ platform: "darwin" }, false, [clis[0]!]), bin);
      expect(none.status).toBe(NO_CODING_AGENT_EXIT);
      expect(none.stdout).toBe("");
    },
  );

  it("keeps the task and session out of the script text on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const script = codingAgentScript({ platform }, true, [fakeCli("agent")]);
      expect(script).not.toContain("whoami");
      expect(script).toContain(AGENT_TASK_VARIABLE);
      expect(script).toContain(AGENT_SESSION_VARIABLE);
    }
    expect(codingAgentScript({ platform: "win32" }, false, [fakeCli("agent")])).toBe(
      "if (Get-Command 'agent' -ErrorAction SilentlyContinue) { Write-Output 'rakazo-coding-agent 0'; & 'agent' 'run' $env:RAKAZO_AGENT_TASK; exit $LASTEXITCODE }\nexit 127",
    );
  });
});

describe("codingAgentReader", () => {
  it("hands lines after the marker to the agent that ran, across chunk boundaries", () => {
    const reader = codingAgentReader([fakeCli("first"), fakeCli("second")]);
    reader.write("rakazo-coding-agent 1\nhel");
    reader.write("lo");
    expect(reader.end()).toMatchObject({ result: "hello" });
  });

  it("ignores output when no marker came first", () => {
    const reader = codingAgentReader([fakeCli("first")]);
    reader.write("hello\n");
    expect(reader.end().result).toBeUndefined();
  });
});

describe("claudeCodeCli", () => {
  it("collects the session, steps, answer and refused tools from its stream", () => {
    const reader = codingAgentReader([claudeCodeCli]);
    const lines = [
      "rakazo-coding-agent 0",
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({
        type: "assistant",
        session_id: "s-1",
        message: {
          content: [
            { type: "text", text: "Looking" },
            { type: "tool_use", name: "Bash", input: { command: "pnpm cos   help" } },
            { type: "tool_use", name: "Read", input: { file_path: "AGENTS.md" } },
          ],
        },
      }),
      "not json",
      JSON.stringify({
        type: "result",
        session_id: "s-1",
        is_error: false,
        result: "Storyboard ready. Approve it?",
        permission_denials: [{ tool_name: "WebFetch" }, { tool_name: "WebFetch" }],
      }),
    ];
    reader.write(`${lines.join("\n")}\n`);
    expect(reader.end()).toEqual({
      session: "s-1",
      result: "Storyboard ready. Approve it?",
      failed: false,
      steps: ["Bash: pnpm cos help", "Read: AGENTS.md"],
      denied: ["WebFetch"],
    });
  });

  it("continues a session without prompting anyone", () => {
    expect(claudeCodeCli.args(true)).toEqual([
      "-p",
      AGENT_TASK,
      "--resume",
      AGENT_SESSION,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--permission-prompts",
      "none",
    ]);
  });
});
