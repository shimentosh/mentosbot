import type { CodingAgentCli } from "./coding-agent-cli.js";
import { AGENT_SESSION, AGENT_TASK, codingAgentStep } from "./coding-agent-cli.js";

/**
 * Claude Code in print mode. Its own auto permission mode decides each tool call, and anything
 * that would need a person is refused rather than left waiting, since nobody watches that terminal.
 */
export const claudeCodeCli: CodingAgentCli = {
  command: "claude",
  args: (resume) => [
    "-p",
    AGENT_TASK,
    ...(resume ? (["--resume", AGENT_SESSION] as const) : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "auto",
    "--permission-prompts",
    "none",
  ],
  read(line, outcome) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.session_id === "string") outcome.session = event.session_id;
    if (event.type === "assistant") {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        outcome.steps.push(
          codingAgentStep(
            block.name,
            input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url,
          ),
        );
      }
      return;
    }
    if (event.type !== "result") return;
    if (typeof event.result === "string") outcome.result = event.result;
    outcome.failed = event.is_error === true;
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    for (const denial of denials) {
      const name = (denial as { tool_name?: unknown } | null)?.tool_name;
      if (typeof name === "string" && !outcome.denied.includes(name)) outcome.denied.push(name);
    }
  },
};
