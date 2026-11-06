import type { HostComputerEnvironment } from "./host-computer-protocol.js";

/** Stands in for the task in an adapter's arguments; it reaches the agent as a variable. */
export const AGENT_TASK: unique symbol = Symbol("task");
/** Stands in for the session to continue. */
export const AGENT_SESSION: unique symbol = Symbol("session");
export type CodingAgentArg = string | typeof AGENT_TASK | typeof AGENT_SESSION;

export const AGENT_TASK_VARIABLE = "RAKAZO_AGENT_TASK";
export const AGENT_SESSION_VARIABLE = "RAKAZO_AGENT_SESSION";
/** The script's exit code when none of the agents is installed. */
export const NO_CODING_AGENT_EXIT = 127;
/** The script's first line names the agent that runs. */
const AGENT_MARKER = "rakazo-coding-agent";

/** What one session of a coding agent did, folded from its output lines. */
export interface CodingAgentOutcome {
  /** Passed back to continue the same session. */
  session?: string;
  /** The agent's final answer. */
  result?: string;
  failed?: boolean;
  /** Short lines for the steps it took, oldest first. */
  steps: string[];
  /** Tools the agent was not allowed to use. */
  denied: string[];
}

/** A coding agent command-line tool on the user's computer, run in their project folder. */
export interface CodingAgentCli {
  /** Command looked up on the user's PATH. */
  command: string;
  /** Arguments to run one task, or to continue `AGENT_SESSION` with it, without prompting. */
  args(resume: boolean): CodingAgentArg[];
  /** Folds one line of the agent's output into the outcome. */
  read(line: string, outcome: CodingAgentOutcome): void;
}

/**
 * A script for the user's shell that runs the first of `clis` that is installed, with no input
 * to wait for. The task and the session reach it only as environment variables, never as script text.
 */
export function codingAgentScript(
  environment: Pick<HostComputerEnvironment, "platform">,
  resume: boolean,
  clis: readonly CodingAgentCli[],
): string {
  if (environment.platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const arg = (value: CodingAgentArg) =>
      value === AGENT_TASK
        ? `$env:${AGENT_TASK_VARIABLE}`
        : value === AGENT_SESSION
          ? `$env:${AGENT_SESSION_VARIABLE}`
          : quote(value);
    return [
      ...clis.map(
        (cli, index) =>
          `if (Get-Command ${quote(cli.command)} -ErrorAction SilentlyContinue) { Write-Output '${AGENT_MARKER} ${index}'; & ${quote(cli.command)} ${cli.args(resume).map(arg).join(" ")}; exit $LASTEXITCODE }`,
      ),
      `exit ${NO_CODING_AGENT_EXIT}`,
    ].join("\n");
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const arg = (value: CodingAgentArg) =>
    value === AGENT_TASK
      ? `"$${AGENT_TASK_VARIABLE}"`
      : value === AGENT_SESSION
        ? `"$${AGENT_SESSION_VARIABLE}"`
        : quote(value);
  return [
    ...clis.map(
      (cli, index) =>
        `if command -v ${quote(cli.command)} >/dev/null 2>&1; then echo '${AGENT_MARKER} ${index}'; exec ${quote(cli.command)} ${cli.args(resume).map(arg).join(" ")} </dev/null; fi`,
    ),
    `exit ${NO_CODING_AGENT_EXIT}`,
  ].join("\n");
}

/** Reads the script's output line by line: the marker picks the agent, which reads the rest. */
export function codingAgentReader(clis: readonly CodingAgentCli[]) {
  const outcome: CodingAgentOutcome = { steps: [], denied: [] };
  let cli: CodingAgentCli | undefined;
  let pending = "";
  const line = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!cli) {
      const match = new RegExp(`^${AGENT_MARKER} (\\d+)$`).exec(trimmed);
      cli = match ? clis[Number(match[1])] : undefined;
      return;
    }
    cli.read(trimmed, outcome);
  };
  return {
    outcome,
    write(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const text of lines) line(text);
    },
    end() {
      line(pending);
      pending = "";
      return outcome;
    },
  };
}

/** One short line for a step, as the activity and the bot see it. */
export function codingAgentStep(name: string, detail: unknown): string {
  const text = typeof detail === "string" ? detail.replaceAll(/\s+/g, " ").trim() : "";
  const short = text.length > STEP_DETAIL_LIMIT ? `${text.slice(0, STEP_DETAIL_LIMIT)}…` : text;
  return short ? `${name}: ${short}` : name;
}

const STEP_DETAIL_LIMIT = 120;
