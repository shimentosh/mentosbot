import type { ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "@rakazo/adapters";

const CONTROL_NOTE =
  "Using the screen takes control of it: the bot that owns the computer waits until you call release_control, or until about 90 seconds pass with no call.";

function builtin(name: string): ConnectorTool {
  const tool = builtinAgentTools.find((each) => each.name === name);
  if (!tool) throw new Error(`missing builtin tool ${name}`);
  return tool;
}

const act = builtin("computer_act");

/** The tools an outside AI gets for one bot's computer. `run_command` only with that permission. */
export function computerAccessTools(options: { allowCommands: boolean }): ConnectorTool[] {
  return [
    {
      name: "computer_status",
      description:
        "Say whether the computer is running, which bot it belongs to, and whether someone else is using its screen.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "computer_start",
      description:
        "Start the computer if it is stopped, and wait until it is ready. It can take a minute or two.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "screenshot",
      description: `Capture the computer's current screen. Returns its size and an image; use its pixel coordinates for computer_act. ${CONTROL_NOTE}`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "computer_act",
      description: `${act.description} ${CONTROL_NOTE}`,
      inputSchema: act.inputSchema,
    },
    ...(options.allowCommands
      ? [
          {
            name: "run_command",
            description:
              "Run a shell command on the computer and return its output and exit code. cwd defaults to the bot's workspace. Commands stop after timeout_seconds (default 120, at most 600); start longer work in the background and read its log.",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string", minLength: 1 },
                cwd: { type: "string" },
                timeout_seconds: { type: "number" },
              },
              required: ["command"],
            },
          } satisfies ConnectorTool,
        ]
      : []),
    {
      name: "list_files",
      description: "List files in a folder of the bot's workspace. path defaults to its root.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the bot's workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file in the bot's workspace, replacing any file at that path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "release_control",
      description: "Hand the screen back to the bot. Call it when you are done.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}
