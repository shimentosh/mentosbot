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

/** The page actions an outside AI may take: none that fill a saved login, card or code. */
export const ACCESS_BROWSER_ACT_KINDS = ["click", "fill", "type", "upload"] as const;

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
    {
      name: "browser_navigate",
      description: `Open an http(s) URL in the computer's browser and return the page like browser_snapshot. Prefer the browser tools over pixel clicks for web pages. ${CONTROL_NOTE}`,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", minLength: 1 } },
        required: ["url"],
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Read the browser's current page as text, with element refs (e1, e2, …) for browser_act. query lists only the controls whose name, label or nearby text match it. If loading is true, take another snapshot.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "browser_act",
      description: `Act on page elements by ref from browser_snapshot. click is a real mouse click; fill sets a field's text or picks a dropdown option by label; type presses keys like a keyboard; upload attaches workspace files to a file input. The result shows the page after the actions. ${CONTROL_NOTE}`,
      inputSchema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...ACCESS_BROWSER_ACT_KINDS] },
                ref: { type: "string" },
                text: { type: "string", description: "For fill and type." },
                paths: {
                  type: "array",
                  items: { type: "string" },
                  description: "For upload: workspace file paths.",
                },
              },
              required: ["kind", "ref"],
            },
          },
        },
        required: ["actions"],
      },
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
