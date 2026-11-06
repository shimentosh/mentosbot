import path from "node:path";
import type { AgentToolExecutionResult, ProcessEvent } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES, attachmentSizeLabel } from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  redactSecrets,
  sandboxCommandTimeoutMs,
} from "@rakazo/core";
import { z } from "zod";
import { setBotFolder } from "./bot-folders.js";
import type { CodingAgentCli } from "./coding-agent-cli.js";
import {
  AGENT_SESSION_VARIABLE,
  AGENT_TASK_VARIABLE,
  codingAgentReader,
  codingAgentScript,
  NO_CODING_AGENT_EXIT,
} from "./coding-agent-cli.js";
import { claudeCodeCli } from "./coding-agent-cli-claude-code.js";
import type { HostComputerEnvironment } from "./host-computer-protocol.js";
import type {
  HostScreenAction,
  HostScreenActResult,
  HostScreenObservation,
} from "./host-screen.js";
import { HOST_SCREEN_MAX_ACTIONS, hostScreenAction } from "./host-screen.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import {
  checkUserComputerFolder,
  keptCommandOutput,
  listKeptCommands,
  openUserComputer,
  requestLocalApp,
  startKeptCommand,
  stopKeptCommand,
} from "./user-computer-projects.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_AGENT_TOOL,
  USER_COMPUTER_ATTACH_TOOL,
  USER_COMPUTER_FOLDER_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_PROCESS_TOOL,
  USER_COMPUTER_REQUEST_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
} from "./user-computer-tools.js";

export {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_AGENT_TOOL,
  USER_COMPUTER_ATTACH_TOOL,
  USER_COMPUTER_FOLDER_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_PROCESS_TOOL,
  USER_COMPUTER_REQUEST_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
};

/** How far back a chain of bot messages is followed to the person or routine that began it. */
const MAX_BOT_MESSAGE_HOPS = 6;

/**
 * Whether a bot's message to another of its owner's bots comes from the owner's own work: a
 * message or routine of theirs started the chain, and no bot along it is shared with teammates.
 * Work a channel, webhook or someone else began never reaches the owner's computer this way.
 */
export async function botMessageFromOwnersWork(
  prisma: RunContext["deps"]["prisma"],
  sourceMessageId: string | null | undefined,
  hops = 0,
): Promise<boolean> {
  if (!sourceMessageId || hops >= MAX_BOT_MESSAGE_HOPS) return false;
  const inbound = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = (Array.isArray(inbound?.blocks) ? inbound.blocks : []) as Array<{
    kind?: unknown;
    returnToMessageId?: unknown;
  } | null>;
  const returnTo = blocks.find(
    (block) => block?.kind === "bot_message_received",
  )?.returnToMessageId;
  if (typeof returnTo !== "string") return false;
  const outbound = await prisma.message.findUnique({
    where: { id: returnTo },
    select: { runId: true },
  });
  const sender = outbound?.runId
    ? await prisma.run.findUnique({
        where: { id: outbound.runId },
        select: {
          trigger: true,
          userId: true,
          sourceMessageId: true,
          bot: { select: { id: true, userId: true } },
          sourceMessage: { select: { role: true, authorUserId: true } },
        },
      })
    : null;
  if (!sender || sender.userId !== sender.bot.userId) return false;
  if ((await prisma.botAccess.count({ where: { botId: sender.bot.id } })) > 0) return false;
  if (sender.trigger === "bot_message")
    return botMessageFromOwnersWork(prisma, sender.sourceMessageId, hops + 1);
  return (
    userComputerOwner({
      trigger: sender.trigger,
      sourceRole: sender.sourceMessage?.role,
      messagingChannelRun: false,
      runUserId: sender.userId,
      botUserId: sender.bot.userId,
      sharedWithTeammates: Boolean(sender.sourceMessage?.authorUserId),
    }) !== undefined
  );
}

/** Whether the run's owner has their desktop connected, or could connect one. */
export type UserComputerState = "connected" | "offline" | undefined;

const USER_COMPUTER_UNAVAILABLE =
  "The user's computer is not connected. Ask them to open the Rakazo desktop app.";

/**
 * Whose own computer this run may reach: the person whose message or routine started it, when
 * they own the bot. Webhooks, channels, other bots and other people's messages reach no one's, and
 * neither does a bot shared with teammates: they share its chat, so they could steer the run or
 * answer its approval cards.
 */
export function userComputerOwner(input: {
  trigger: string;
  sourceRole: string | undefined;
  messagingChannelRun: boolean;
  runUserId: string;
  botUserId: string;
  sharedWithTeammates?: boolean;
}): string | undefined {
  if (input.sharedWithTeammates || input.messagingChannelRun) return undefined;
  // The owner's own routines run on their computer too, as they set them up.
  const ownRoutine = input.trigger === "routine";
  const ownMessage =
    (input.trigger === "user" || input.trigger === "follow_up") && input.sourceRole === "user";
  if (!ownRoutine && !ownMessage) return undefined;
  return input.runUserId === input.botUserId ? input.runUserId : undefined;
}

/**
 * The user's own computer always asks a person first, in every approval mode and whatever the
 * rules allow, until they choose "Allow in this space"; a block still refuses it. These tools run
 * only in the user's own runs (see userComputerOwner), so any effect of them past "intended" in
 * this space traces back to that approval. Removing every paired computer ends it, so pairing again
 * asks again. Screen control is approved per app.
 */
export async function userComputerGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  if (blocked) return "deny";
  const { deps, run } = ctx;
  const pairedSince = await deps.userDevices?.pairedSince(run.userId);
  if (!pairedSince) return "ask";
  const where = {
    spaceId: run.spaceId,
    status: { in: ["approved", "executing", "completed", "uncertain"] },
    createdAt: { gte: pairedSince },
    run: { userId: run.userId },
  };
  if (!USER_COMPUTER_SCREEN_TOOLS.has(name)) {
    const allowed = await deps.prisma.externalEffect.findFirst({
      where: {
        ...where,
        kind:
          name === USER_COMPUTER_SHELL_TOOL
            ? USER_COMPUTER_SHELL_TOOL
            : { in: [USER_COMPUTER_SHELL_TOOL, name] },
      },
      select: { id: true },
    });
    return allowed ? "allow" : "ask";
  }
  const app = userComputerAppName(args.app).toLowerCase();
  if (!app) return "ask";
  // Every screen action records an effect, so page through them rather than cap the search.
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.prisma.externalEffect.findMany({
      where: { ...where, kind: { in: [...USER_COMPUTER_SCREEN_TOOLS] } },
      select: { id: true, request: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SCREEN_APPROVAL_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (
      page.some(
        (effect) =>
          userComputerAppName((effect.request as { app?: unknown } | null)?.app).toLowerCase() ===
          app,
      )
    )
      return "allow";
    if (page.length < SCREEN_APPROVAL_PAGE) return "ask";
    cursor = page.at(-1)!.id;
  }
}

const SCREEN_APPROVAL_PAGE = 200;

/**
 * The working directory on the user's computer: their home or a folder inside it. A relative
 * path, or none, starts from `base` (the bot's project folder there) when given.
 */
export function userComputerCwd(
  environment: HostComputerEnvironment,
  cwd: unknown,
  base?: string,
): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof cwd === "string" ? cwd.trim() : "";
  if (requested === "~") return environment.home;
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  const resolved = paths.resolve(environment.home, base ?? "", expanded);
  const relative = paths.relative(environment.home, resolved);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    throw new Error("cwd must be inside the user's home folder; cd elsewhere within the command");
  return resolved;
}

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** Checked again at execution: the desktop can disconnect or be revoked after the offer. */
async function connectedUserComputer(ctx: RunContext) {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  const device = owner && devices ? await devices.connected(owner).catch(() => null) : null;
  return owner && devices && device ? { owner, devices, deviceId: device.deviceId } : undefined;
}

/** This bot's project folder for the user, when it is on the computer that is connected. */
async function projectFolder(ctx: RunContext, owner: string, deviceId: string) {
  const folder = await ctx.deps.prisma.botFolder.findUnique({
    where: { botId_userId: { botId: ctx.bot.id, userId: owner } },
    select: { deviceId: true, path: true },
  });
  return folder?.deviceId === deviceId ? folder.path : undefined;
}

export async function userComputerShell(ctx: RunContext, call: ToolCall) {
  const { bot, runId } = ctx;
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  const command = String(call.args.command ?? "");
  try {
    // The device only executes for a provisioned bot; provisioning is idempotent.
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    const observed = await observeShellCommand(
      devices.request<ProcessEvent>(
        owner,
        {
          method: "execute",
          botId: bot.id,
          runId,
          command: {
            argv: nativeShellCommandArgv(command, environment),
            cwd: userComputerCwd(
              environment,
              call.args.cwd,
              await projectFolder(ctx, owner, deviceId),
            ),
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
        deviceId,
      ),
      { secrets: ctx.secrets },
    );
    if (!observed.completion) return call.finish(observed.result);
    void observed.completion.catch(() => undefined);
    const returned = await call.finish({ ...observed.result, notice: SHELL_STILL_RUNNING_NOTICE });
    if (isRunningShellCommand(returned)) call.observer?.onShellStillRunning?.(observed.completion);
    return returned;
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the command: ${reason}` });
  }
}

/** Sets or clears this bot's project folder for the user, once the folder is found there. */
export async function userComputerFolder(ctx: RunContext, call: ToolCall) {
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner } = connected;
  const { bot, run } = ctx;
  const requested = typeof call.args.path === "string" ? call.args.path.trim() : "";
  if (!requested) {
    await ctx.deps.prisma.botFolder.deleteMany({ where: { botId: bot.id, userId: owner } });
    return call.finish({ ok: true, folder: null });
  }
  const { signal } = ctx.context;
  try {
    const session = await userComputerSession(ctx, connected);
    if (!session) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
    let folder: string;
    try {
      folder = await checkUserComputerFolder(session, requested);
    } catch (error) {
      if (signal.aborted) throw error;
      return call.finish({ error: error instanceof Error ? error.message : "No such folder." });
    }
    await setBotFolder(ctx.deps.prisma, {
      botId: bot.id,
      userId: owner,
      spaceId: run.spaceId,
      deviceId: session.deviceId,
      path: folder,
    });
    return call.finish({ ok: true, folder });
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "folder check failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not answer: ${reason}` });
  }
}

/** The connected computer, opened for this bot's run. */
async function userComputerSession(
  ctx: RunContext,
  connected: NonNullable<Awaited<ReturnType<typeof connectedUserComputer>>>,
) {
  return openUserComputer({
    devices: connected.devices,
    owner: connected.owner,
    botId: ctx.bot.id,
    runId: ctx.runId,
    signal: ctx.context.signal,
  });
}

/** Keeps a command running on the user's computer, lists those kept, reads one's output or stops it. */
export async function userComputerProcess(ctx: RunContext, call: ToolCall) {
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { signal } = ctx.context;
  const action = String(call.args.action ?? "");
  const name = String(call.args.name ?? "").trim() || (action === "start" ? "app" : "");
  try {
    const session = await userComputerSession(ctx, connected);
    if (!session) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
    if (action === "list") return call.finish({ processes: await listKeptCommands(session) });
    if (!name) return call.finish({ error: "Say which one by its name." });
    if (action === "logs")
      return call.finish({
        name,
        output: redactSecrets(await keptCommandOutput(session, name), ctx.secrets),
      });
    if (action === "stop") return call.finish(await stopKeptCommand(session, name));
    if (action !== "start") return call.finish({ error: "action is start, list, logs or stop." });
    const folder = userComputerCwd(
      session.environment,
      call.args.cwd,
      await projectFolder(ctx, connected.owner, session.deviceId),
    );
    const started = await startKeptCommand(session, {
      name,
      command: String(call.args.command ?? ""),
      folder,
    });
    return call.finish({
      ...started,
      output: redactSecrets(started.output, ctx.secrets),
      folder,
      ...(started.running
        ? {}
        : { notice: "It stopped on its own; its output says why. Fix it and start it again." }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: reason });
  }
}

/** Calls the HTTP API of an app running on the user's computer, from that computer. */
export async function userComputerRequest(ctx: RunContext, call: ToolCall) {
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { signal } = ctx.context;
  try {
    const session = await userComputerSession(ctx, connected);
    if (!session) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
    const answer = await requestLocalApp(session, {
      method: typeof call.args.method === "string" ? call.args.method : undefined,
      url: String(call.args.url ?? ""),
      body: call.args.body,
    });
    return call.finish(
      JSON.parse(redactSecrets(JSON.stringify(answer), ctx.secrets)) as typeof answer,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return call.finish({
      error: redactSecrets(error instanceof Error ? error.message : "request failed", ctx.secrets),
    });
  }
}

/** Coding agents tried in order on the user's computer; the first one installed runs. */
const CODING_AGENTS: readonly CodingAgentCli[] = [claudeCodeCli];
const AGENT_STEPS_SHOWN = 30;
const AGENT_ERROR_TAIL = 2_000;

/**
 * Hands a task to the coding agent installed on the user's computer, in this bot's project
 * folder there, and waits for its answer (up to the longest command time).
 */
export async function userComputerAgent(ctx: RunContext, call: ToolCall) {
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const task = typeof call.args.task === "string" ? call.args.task.trim() : "";
  if (!task) return call.finish({ error: "task must say what the coding agent should do." });
  const session = typeof call.args.session === "string" ? call.args.session.trim() : "";
  const folder = await projectFolder(ctx, owner, deviceId);
  if (!folder)
    return call.finish({
      error: "Set your project folder on the user's computer first with user_computer_folder.",
    });
  const { bot, runId } = ctx;
  const { signal } = ctx.context;
  const reader = codingAgentReader(CODING_AGENTS);
  let stderr = "";
  let exitCode: number | undefined;
  try {
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    for await (const event of devices.request<ProcessEvent>(
      owner,
      {
        method: "execute",
        botId: bot.id,
        runId,
        command: {
          argv: nativeShellCommandArgv(
            codingAgentScript(environment, Boolean(session), CODING_AGENTS),
            environment,
          ),
          cwd: folder,
          env: {
            [AGENT_TASK_VARIABLE]: task,
            ...(session ? { [AGENT_SESSION_VARIABLE]: session } : {}),
          },
          timeoutMs: MAX_SANDBOX_COMMAND_TIMEOUT_MS,
        },
      },
      signal,
      deviceId,
    )) {
      if (event.type === "stdout") reader.write(event.data);
      else if (event.type === "stderr") stderr = (stderr + event.data).slice(-AGENT_ERROR_TAIL);
      else exitCode = event.code;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "the coding agent stopped",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish: ${reason}` });
  }
  const outcome = reader.end();
  if (exitCode === NO_CODING_AGENT_EXIT && outcome.result === undefined)
    return call.finish({
      error:
        "No coding agent is installed on the user's computer. Tell them to install one and sign in to it in their terminal.",
    });
  const redact = (text: string) => redactSecrets(text, ctx.secrets);
  const steps = outcome.steps.slice(-AGENT_STEPS_SHOWN).map(redact);
  if (outcome.result === undefined)
    return call.finish({
      error: `The coding agent stopped without an answer (exit code ${exitCode ?? "unknown"}).`,
      ...(stderr.trim() ? { output: redact(stderr.trim()) } : {}),
      ...(outcome.session ? { session: outcome.session } : {}),
      steps,
    });
  return call.finish({
    result: redact(outcome.result),
    ...(outcome.session ? { session: outcome.session } : {}),
    ...(outcome.failed ? { failed: true } : {}),
    ...(outcome.denied.length ? { denied: outcome.denied } : {}),
    steps,
  });
}

const ATTACH_FILE_VARIABLE = "RAKAZO_ATTACH_FILE";
const ATTACH_MAX_VARIABLE = "RAKAZO_ATTACH_MAX";
const ATTACH_MISSING_EXIT = 66;
const ATTACH_TOO_LARGE_EXIT = 65;

/**
 * Prints the file as base64, or exits early when it is missing or over the limit. The path and
 * the limit reach the shell as variables, never as command text.
 */
export function userComputerAttachScript(environment: Pick<HostComputerEnvironment, "platform">) {
  if (environment.platform === "win32")
    return [
      `$f = $env:${ATTACH_FILE_VARIABLE}`,
      `if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { exit ${ATTACH_MISSING_EXIT} }`,
      `if ((Get-Item -LiteralPath $f).Length -gt [int64]$env:${ATTACH_MAX_VARIABLE}) { exit ${ATTACH_TOO_LARGE_EXIT} }`,
      "[Convert]::ToBase64String([IO.File]::ReadAllBytes($f))",
    ].join("\n");
  return [
    `f="$${ATTACH_FILE_VARIABLE}"`,
    `[ -f "$f" ] || exit ${ATTACH_MISSING_EXIT}`,
    `[ "$(wc -c < "$f" | tr -d '[:space:]')" -le "$${ATTACH_MAX_VARIABLE}" ] || exit ${ATTACH_TOO_LARGE_EXIT}`,
    `base64 < "$f"`,
  ].join("\n");
}

/** Sends a file from the user's computer to this chat, through the server's artifact storage. */
export async function userComputerAttach(ctx: RunContext, call: ToolCall) {
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { deps, bot, run, runId, thread } = ctx;
  if (!deps.artifacts) return call.finish({ error: "artifact storage unavailable" });
  const { owner, devices, deviceId } = connected;
  const requested = typeof call.args.path === "string" ? call.args.path.trim() : "";
  if (!requested) return call.finish({ error: "path must name a file on the user's computer." });
  if (!inferAttachmentMimeType(requested))
    return call.finish({ error: "unsupported attachment type", path: requested });
  const limit = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  const { signal } = ctx.context;
  let encoded = "";
  let exitCode: number | undefined;
  let file = requested;
  try {
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    try {
      file = userComputerCwd(environment, requested, await projectFolder(ctx, owner, deviceId));
    } catch {
      return call.finish({ error: "The file must be inside the user's home folder." });
    }
    // Base64 adds a third, plus line breaks on some systems.
    const encodedLimit = Math.ceil(limit / 3) * 4 + Math.ceil(limit / 48) + 16;
    for await (const event of devices.request<ProcessEvent>(
      owner,
      {
        method: "execute",
        botId: bot.id,
        runId,
        command: {
          argv: nativeShellCommandArgv(userComputerAttachScript(environment), environment),
          cwd: environment.home,
          env: { [ATTACH_FILE_VARIABLE]: file, [ATTACH_MAX_VARIABLE]: String(limit) },
          timeoutMs: MAX_SANDBOX_COMMAND_TIMEOUT_MS,
        },
      },
      signal,
      deviceId,
    )) {
      if (event.type === "stdout") {
        encoded += event.data;
        if (encoded.length > encodedLimit) throw new Error("the file grew past the limit");
      } else if (event.type === "exit") exitCode = event.code;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "the transfer stopped",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not send the file: ${reason}` });
  }
  if (exitCode === ATTACH_MISSING_EXIT)
    return call.finish({ error: `There is no file at ${file} on the user's computer.` });
  if (exitCode === ATTACH_TOO_LARGE_EXIT)
    return call.finish({
      error: `${file} is larger than the ${attachmentSizeLabel(limit)} attachment limit.`,
    });
  if (exitCode !== 0) return call.finish({ error: `The user's computer could not read ${file}.` });
  const bytes = Buffer.from(encoded, "base64");
  try {
    const attached = await attachWorkspaceFileToThread(
      { prisma: deps.prisma, artifacts: deps.artifacts, maxUploadSizeBytes: limit },
      {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        groupId: thread.groupId ?? undefined,
        runId: run.id,
        filePath: file,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        operationId: call.executionId,
        name: typeof call.args.name === "string" ? call.args.name : undefined,
        description: typeof call.args.description === "string" ? call.args.description : undefined,
      },
    );
    await publishMessage(deps, run, "bot", [attached.block]);
    return call.finish({ ok: true, artifactId: attached.artifactId, path: file });
  } catch (error) {
    return call.finish({
      error: error instanceof Error ? error.message : "could not attach file",
      path: file,
    });
  }
}

const screenActions = z.array(hostScreenAction).min(1).max(HOST_SCREEN_MAX_ACTIONS);

export function userComputerObserve(ctx: RunContext, call: ToolCall) {
  const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
  return userComputerScreen(ctx, call, {
    method: "screenObserve",
    app: userComputerAppName(call.args.app),
    ...(query ? { query } : {}),
  });
}

export function userComputerAct(ctx: RunContext, call: ToolCall) {
  const actions = screenActions.safeParse(call.args.actions);
  if (!actions.success) {
    const issue = actions.error.issues[0];
    const where = issue?.path.length ? `actions.${issue.path.join(".")}: ` : "actions: ";
    return call.finish({ error: `${where}${issue?.message ?? "invalid"}` });
  }
  return userComputerScreen(ctx, call, {
    method: "screenAct",
    app: userComputerAppName(call.args.app),
    actions: actions.data,
  });
}

type ScreenRequest =
  | { method: "screenObserve"; app: string; query?: string }
  | { method: "screenAct"; app: string; actions: HostScreenAction[] };

/** The device gets the app name the approval card showed, never the raw argument. */
async function userComputerScreen(ctx: RunContext, call: ToolCall, request: ScreenRequest) {
  if (!request.app) return call.finish({ error: "app must name an app on the user's computer." });
  const connected = await connectedUserComputer(ctx);
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  const { owner, devices, deviceId } = connected;
  const { signal } = ctx.context;
  try {
    const value = await lastValue(
      devices.request<HostScreenObservation | HostScreenActResult>(
        owner,
        { ...request, botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    if (request.method === "screenObserve")
      return call.finish(screenToolResult(ctx, value as HostScreenObservation, "observed"));
    const acted = value as HostScreenActResult;
    const total = request.actions.length;
    const note = `completed ${acted.completed} of ${total} action${total === 1 ? "" : "s"}${
      acted.error ? `; stopped: ${redactSecrets(acted.error, ctx.secrets)}` : ""
    }`;
    return call.finish(
      acted.observation
        ? screenToolResult(ctx, acted.observation, note)
        : { completed: acted.completed, ...(acted.error ? { error: note } : {}) },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "screen control failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish: ${reason}` });
  }
}

/** Only the window's name and size are stored; the rows and screenshot reach the model alone. */
function screenToolResult(
  ctx: RunContext,
  observation: HostScreenObservation,
  note: string,
): AgentToolExecutionResult {
  const image = ctx.computer.acceptsImages ? observation.image : undefined;
  const details = {
    app: observation.app,
    ...(observation.title ? { title: redactSecrets(observation.title, ctx.secrets) } : {}),
    ...(image ? { width: image.width, height: image.height } : {}),
  };
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}\n${JSON.stringify(details)}\n${redactSecrets(observation.tree, ctx.secrets)}`,
      },
      ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    details,
  };
}
