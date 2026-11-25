import { ORPCError } from "@orpc/server";
import type { ComputerObservation } from "@rakazo/adapter-kit";
import {
  displayBotWorkspacePath,
  ensureComputerWorkspaceLayout,
  nativeShellCommandArgv,
  parseComputerActions,
  protectedComputerLifecycleRefusal,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  sandboxKindCapabilities,
  WorkspacePathError,
  wakeableComputerRef,
} from "@rakazo/adapters";
import { ClientError, deadlineSignal } from "@rakazo/core";
import { createRepos, parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { bootBotComputer } from "../computers/computer-boot.js";
import {
  computerScreenContext,
  computerStatus,
  expireStaleComputerControl,
  holdsComputerControl,
  keepComputerAwake,
  releaseComputerControl,
  takeComputerControl,
} from "../computers/computer-control.js";
import type { RouterDeps } from "../router.js";
import { computerContext } from "../routes/shared.js";
import type { AccessGrant } from "./access-keys.js";

/** What a tool call answers, in the shape MCP sends back. */
export type ToolAnswer = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

const DEFAULT_COMMAND_SECONDS = 120;
const MAX_COMMAND_SECONDS = 600;
/** The tail of each stream a command returns; earlier output is dropped. */
const MAX_COMMAND_OUTPUT_CHARS = 60_000;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

const text = (value: string): ToolAnswer => ({ content: [{ type: "text", text: value }] });
const refusal = (value: string): ToolAnswer => ({ ...text(value), isError: true });

/** A problem the calling AI can act on, as opposed to a server fault. */
class ToolRefusal extends Error {}

function observationAnswer(observation: ComputerObservation, note: string): ToolAnswer {
  const details = {
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
  };
  return {
    content: [
      { type: "text", text: `${note}\n${JSON.stringify(details)}` },
      {
        type: "image",
        data: Buffer.from(observation.image).toString("base64"),
        mimeType: observation.mimeType,
      },
    ],
  };
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function tail(value: string): string {
  return value.length > MAX_COMMAND_OUTPUT_CHARS
    ? `[earlier output dropped]\n${value.slice(-MAX_COMMAND_OUTPUT_CHARS)}`
    : value;
}

/** Runs the tools of one key's MCP session. Each call reads the bot afresh. */
export function createComputerAccessTools(deps: RouterDeps, grant: AccessGrant) {
  const { actor, botId } = grant;
  const repos = createRepos(deps.prisma);

  async function loadBot() {
    let bot = await repos.getBot(actor, botId);
    if (await expireStaleComputerControl(deps, bot.computer))
      bot = await repos.getBot(actor, botId);
    if (!bot.computer) throw new ToolRefusal("This bot has no computer.");
    return { bot, computer: bot.computer };
  }

  async function runningComputer() {
    const loaded = await loadBot();
    if (loaded.computer.state !== "running" || !loaded.computer.providerRef) {
      throw new ToolRefusal("The computer is not running. Call computer_start first.");
    }
    return loaded;
  }

  /** Take or renew control of the screen, so the bot waits while the outside AI drives it. */
  async function controlledComputer(operation: string) {
    const loaded = await runningComputer();
    await takeComputerControl(deps, actor, botId);
    await keepComputerAwake(deps, loaded.computer.id);
    const ref = await wakeableComputerRef(deps.prisma, loaded.computer);
    const context = await computerScreenContext(
      deps.prisma,
      actor,
      loaded.computer.id,
      botId,
      operation,
    );
    return { ...loaded, ref, context };
  }

  async function workspaceComputer(operation: string) {
    const loaded = await runningComputer();
    await keepComputerAwake(deps, loaded.computer.id);
    const ref = await wakeableComputerRef(deps.prisma, loaded.computer);
    const context = computerContext(actor, botId, operation);
    const mode = parseComputerMode(loaded.computer.scope);
    await ensureComputerWorkspaceLayout(deps.sandbox, ref, mode, botId, context);
    return { ...loaded, ref, context, mode };
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<ToolAnswer>> = {
    async computer_status() {
      const status = await computerStatus(deps, actor, botId);
      const bot = await repos.getBot(actor, botId);
      return text(
        JSON.stringify({
          bot: bot.name,
          state: status.state,
          screen:
            status.controlHolder === "user"
              ? status.controlledByOther
                ? "someone else is using it"
                : "you have control"
              : status.controlHolder === "bot"
                ? "the bot is using it"
                : "free",
        }),
      );
    },
    async computer_start() {
      await loadBot();
      const status = await bootBotComputer(deps, actor, botId);
      return text(`Computer is ${status.state}.`);
    },
    async screenshot() {
      const { ref, context } = await controlledComputer("screen");
      return observationAnswer(await deps.sandbox.observe(ref, context), "screen captured");
    },
    async computer_act(args) {
      let actions: ReturnType<typeof parseComputerActions>;
      try {
        actions = parseComputerActions(args.actions);
      } catch (error) {
        throw new ToolRefusal(error instanceof Error ? error.message : "invalid actions");
      }
      const { ref, context } = await controlledComputer("act");
      const result = await deps.sandbox.act(
        ref,
        {
          actions,
          observe: args.observe !== false,
          settleMs: numberArg(args.settle_ms, 0, 0, 5_000),
        },
        context,
      );
      const note = `completed ${result.completed} of ${actions.length} actions`;
      return result.observation ? observationAnswer(result.observation, note) : text(note);
    },
    async run_command(args) {
      if (!grant.allowCommands) throw new ToolRefusal("This key may not run commands.");
      const command = String(args.command ?? "").trim();
      if (!command) throw new ToolRefusal("command is required");
      const { computer, ref, context } = await controlledComputer("command");
      const native = sandboxKindCapabilities(ref.kind).nativeShell;
      if (!native) {
        const reason = protectedComputerLifecycleRefusal(command);
        if (reason) throw new ToolRefusal(`Refused: ${reason} would reach beyond this bot.`);
      }
      const cwd = resolveBotWorkspaceCwd(
        parseComputerMode(computer.scope),
        botId,
        args.cwd === undefined ? undefined : String(args.cwd),
      );
      const environment = native ? await deps.sandbox.environment?.(ref, context) : undefined;
      const timeoutMs =
        numberArg(args.timeout_seconds, DEFAULT_COMMAND_SECONDS, 1, MAX_COMMAND_SECONDS) * 1000;
      let stdout = "";
      let stderr = "";
      let code: number | null = null;
      const signal = deadlineSignal(timeoutMs + 10_000, context.signal);
      for await (const event of deps.sandbox.execute(
        ref,
        {
          argv: environment
            ? nativeShellCommandArgv(command, environment)
            : ["bash", "-lc", command],
          cwd,
          timeoutMs,
        },
        { ...context, signal },
      )) {
        if (event.type === "stdout") stdout = tail(stdout + event.data);
        else if (event.type === "stderr") stderr = tail(stderr + event.data);
        else code = event.code;
      }
      return text(JSON.stringify({ exitCode: code, stdout, stderr }));
    },
    async list_files(args) {
      const { ref, context, mode } = await workspaceComputer("files");
      const shown = args.path === undefined ? "/" : String(args.path);
      const entries = await deps.sandbox.listFiles(
        ref,
        resolveBotWorkspacePath(mode, botId, shown),
        context,
      );
      return text(
        JSON.stringify(
          entries.map((entry) => ({
            path: displayBotWorkspacePath(mode, botId, shown, entry.path),
            kind: entry.kind,
            size: entry.size,
          })),
        ),
      );
    },
    async read_file(args) {
      const { ref, context, mode } = await workspaceComputer("read");
      const bytes = await deps.sandbox.readFile(
        ref,
        resolveBotWorkspacePath(mode, botId, String(args.path ?? "")),
        context,
        { maxBytes: MAX_TEXT_FILE_BYTES },
      );
      return text(new TextDecoder().decode(bytes));
    },
    async write_file(args) {
      const { ref, context, mode } = await workspaceComputer("upload");
      const content = Buffer.from(String(args.content ?? ""), "utf8");
      if (content.byteLength > MAX_TEXT_FILE_BYTES) throw new ToolRefusal("File is too large.");
      await deps.sandbox.writeFile(
        ref,
        { path: resolveBotUploadPath(mode, botId, String(args.path ?? "")), content },
        context,
      );
      return text("saved");
    },
    async release_control() {
      const { bot, computer } = await loadBot();
      if (!holdsComputerControl(computer, bot.id, actor)) return text("You did not have control.");
      await releaseComputerControl(deps, actor, computer, bot.id);
      return text("Control handed back to the bot.");
    },
  };

  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
      const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
      if (!tool || (name === "run_command" && !grant.allowCommands)) {
        return refusal(`Unknown tool ${name}.`);
      }
      try {
        return await tool(args);
      } catch (error) {
        if (
          error instanceof ToolRefusal ||
          error instanceof ClientError ||
          error instanceof ORPCError ||
          error instanceof WorkspacePathError
        ) {
          return refusal(error.message);
        }
        getLogger().warn("computer access tool failed", {
          tool: name,
          "bot.id": botId,
          "access_key.id": grant.keyId,
          error,
        });
        return refusal(`${name} failed. Try again, or call computer_status.`);
      }
    },
  };
}
