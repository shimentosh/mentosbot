import path from "node:path";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import type { HostComputerEnvironment } from "./host-computer-protocol.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/**
 * Project folders and long-running commands on the user's own computer, shared by the bot's
 * tools and the settings screens. Paths and commands reach the shell as variables, never as
 * command text.
 */
export interface UserComputerSession {
  devices: UserDeviceGateway;
  owner: string;
  deviceId: string;
  botId: string;
  runId?: string;
  environment: HostComputerEnvironment;
  signal: AbortSignal;
}

const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_FOLDERS = 400;
/** Lines of a kept command's output a start or a log read returns. */
const LOG_TAIL_BYTES = 6_000;
export const USER_COMPUTER_PROCESS_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Markers of a folder that holds a project, shown beside it when picking one. */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "AGENTS.md",
  "CLAUDE.md",
];

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** Reaches the owner's connected computer for this bot, or undefined when none is connected. */
export async function openUserComputer(input: {
  devices: UserDeviceGateway;
  owner: string;
  botId: string;
  runId?: string;
  signal: AbortSignal;
}): Promise<UserComputerSession | undefined> {
  const device = await input.devices.connected(input.owner).catch(() => null);
  if (!device) return undefined;
  const request = { botId: input.botId, ...(input.runId ? { runId: input.runId } : {}) };
  // The device only executes for a provisioned bot; provisioning is idempotent.
  await lastValue(
    input.devices.request(
      input.owner,
      { method: "provision", ...request },
      input.signal,
      device.deviceId,
    ),
  );
  const environment = await lastValue(
    input.devices.request<HostComputerEnvironment>(
      input.owner,
      { method: "environment", ...request },
      input.signal,
      device.deviceId,
    ),
  );
  return { ...input, deviceId: device.deviceId, environment };
}

/** Runs one POSIX script there with its inputs as environment variables. */
export async function runUserComputerScript(
  session: UserComputerSession,
  script: string,
  env: Record<string, string>,
  cwd: string = session.environment.home,
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let code = 1;
  for await (const event of session.devices.request<ProcessEvent>(
    session.owner,
    {
      method: "execute",
      botId: session.botId,
      ...(session.runId ? { runId: session.runId } : {}),
      command: {
        argv: nativeShellCommandArgv(script, session.environment),
        cwd,
        env,
        timeoutMs,
      },
    },
    session.signal,
    session.deviceId,
  )) {
    if (event.type === "stdout" && stdout.length < MAX_OUTPUT) stdout += event.data;
    else if (event.type === "stderr" && stderr.length < MAX_OUTPUT) stderr += event.data;
    else if (event.type === "exit") code = event.code;
  }
  return { code, stdout, stderr };
}

function paths(environment: HostComputerEnvironment) {
  return environment.platform === "win32" ? path.win32 : path.posix;
}

/** A folder inside the user's home, from an absolute, `~/` or home-relative path. */
export function homeFolder(environment: HostComputerEnvironment, requested: string): string {
  const join = paths(environment);
  const trimmed = requested.trim();
  const expanded = trimmed === "~" ? "" : /^~[\\/]/.test(trimmed) ? trimmed.slice(2) : trimmed;
  const resolved = join.resolve(environment.home, expanded);
  const relative = join.relative(environment.home, resolved);
  if (relative === ".." || relative.startsWith(`..${join.sep}`) || join.isAbsolute(relative))
    throw new Error("The folder must be inside the user's home folder.");
  return resolved;
}

function unsupported(environment: HostComputerEnvironment) {
  return environment.platform === "win32"
    ? "Kept commands need a macOS or Linux computer for now."
    : undefined;
}

export interface FolderListing {
  home: string;
  path: string;
  parent: string | null;
  folders: Array<{ name: string; project: boolean }>;
}

const LIST_FOLDERS = `cd "$RAKAZO_PATH" 2>/dev/null || exit 3
for entry in */; do
  [ -d "$entry" ] || continue
  name=\${entry%/}
  project=0
  for marker in $RAKAZO_MARKERS; do
    if [ -e "$name/$marker" ]; then project=1; break; fi
  done
  printf '%s\\t%s\\n' "$project" "$name"
done`;

// Hidden folders are left out, as `*/` does; UTF-8 output keeps non-English names intact.
const LIST_FOLDERS_WINDOWS = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not (Test-Path -LiteralPath $env:RAKAZO_PATH -PathType Container)) { exit 3 }
$markers = $env:RAKAZO_MARKERS -split ' '
foreach ($entry in Get-ChildItem -LiteralPath $env:RAKAZO_PATH -Directory -ErrorAction SilentlyContinue) {
  if ($entry.Name.StartsWith('.')) { continue }
  $project = 0
  foreach ($marker in $markers) {
    if (Test-Path -LiteralPath (Join-Path $entry.FullName $marker)) { $project = 1; break }
  }
  [Console]::Out.Write("$project\`t$($entry.Name)\`n")
}`;

const FOLDER_EXISTS = 'test -d "$RAKAZO_PATH"';
const FOLDER_EXISTS_WINDOWS =
  "if (Test-Path -LiteralPath $env:RAKAZO_PATH -PathType Container) { exit 0 } else { exit 1 }";

/** The folders inside one folder of the user's home, projects marked, hidden ones left out. */
export async function listUserComputerFolders(
  session: UserComputerSession,
  requested = "",
): Promise<FolderListing> {
  const folder = homeFolder(session.environment, requested);
  const windows = session.environment.platform === "win32";
  const result = await runUserComputerScript(
    session,
    windows ? LIST_FOLDERS_WINDOWS : LIST_FOLDERS,
    {
      RAKAZO_PATH: folder,
      RAKAZO_MARKERS: PROJECT_MARKERS.join(" "),
    },
  );
  if (result.code === 3) throw new Error(`There is no folder at ${folder}.`);
  if (result.code !== 0) throw new Error("The computer could not list that folder.");
  const folders = result.stdout
    .split("\n")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const name = tab < 0 ? "" : line.slice(tab + 1);
      return name ? [{ name, project: line.slice(0, tab) === "1" }] : [];
    })
    .slice(0, MAX_FOLDERS);
  const home = session.environment.home;
  return {
    home,
    path: folder,
    parent: folder === home ? null : paths(session.environment).dirname(folder),
    folders,
  };
}

/** The folder, once it exists inside the user's home and is not the home itself. */
export async function checkUserComputerFolder(
  session: UserComputerSession,
  requested: string,
): Promise<string> {
  const folder = homeFolder(session.environment, requested);
  if (folder === session.environment.home)
    throw new Error("Pick a folder inside the user's home folder.");
  const script = session.environment.platform === "win32" ? FOLDER_EXISTS_WINDOWS : FOLDER_EXISTS;
  const result = await runUserComputerScript(session, script, { RAKAZO_PATH: folder });
  if (result.code !== 0) throw new Error(`There is no folder at ${folder} on the user's computer.`);
  return folder;
}

export interface KeptCommand {
  name: string;
  running: boolean;
  command: string;
  folder: string;
  /** Ports it listens on, such as a dev server's. */
  ports: number[];
}

/**
 * Where kept commands record themselves: one folder per bot, so bots never stop each other's.
 * The command runs in a session of its own, so it outlives the call that started it, the
 * desktop app and the run.
 */
const PROCESS_DIRECTORY = `dir="$HOME/.rakazo/processes/$RAKAZO_BOT"`;

const START = `${PROCESS_DIRECTORY}
mkdir -p "$dir" && chmod 700 "$dir" || exit 1
pidfile="$dir/$RAKAZO_NAME.pid"
if [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo already; exit 0; fi
log="$dir/$RAKAZO_NAME.log"
printf '%s\\n' "$RAKAZO_COMMAND" > "$dir/$RAKAZO_NAME.cmd"
pwd > "$dir/$RAKAZO_NAME.cwd"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "$RAKAZO_COMMAND" </dev/null >"$log" 2>&1 &
else
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' sh -c "$RAKAZO_COMMAND" </dev/null >"$log" 2>&1 &
fi
pid=$!
echo "$pid" > "$pidfile"
sleep "\${RAKAZO_SETTLE:-4}"
if kill -0 "$pid" 2>/dev/null; then echo running; else echo exited; fi
tail -c ${LOG_TAIL_BYTES} "$log"`;

const STOP = `${PROCESS_DIRECTORY}
pidfile="$dir/$RAKAZO_NAME.pid"
[ -s "$pidfile" ] || { echo none; exit 0; }
pid=$(cat "$pidfile")
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
tries=0
while kill -0 "$pid" 2>/dev/null && [ "$tries" -lt 20 ]; do sleep 0.25; tries=$((tries + 1)); done
kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
rm -f "$pidfile"
echo stopped`;

const LIST = `${PROCESS_DIRECTORY}
[ -d "$dir" ] || exit 0
for pidfile in "$dir"/*.pid; do
  [ -e "$pidfile" ] || continue
  name=$(basename "$pidfile" .pid)
  pid=$(cat "$pidfile")
  ports=
  if kill -0 "$pid" 2>/dev/null; then
    state=running
    ports=$(lsof -nP -a -g "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -un | tr '\\n' ' ')
  else
    state=stopped
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$state" "$ports" "$(head -n 1 "$dir/$name.cwd" 2>/dev/null)" "$(head -c 300 "$dir/$name.cmd" 2>/dev/null | head -n 1)"
done`;

const LOGS = `${PROCESS_DIRECTORY}
[ -f "$dir/$RAKAZO_NAME.log" ] || { echo "No output kept for $RAKAZO_NAME." >&2; exit 3; }
tail -c ${LOG_TAIL_BYTES} "$dir/$RAKAZO_NAME.log"`;

function processName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!USER_COMPUTER_PROCESS_NAME.test(normalized))
    throw new Error("Name it with lowercase letters, digits and dashes, such as dev-server.");
  return normalized;
}

function processEnv(session: UserComputerSession, name?: string) {
  return { RAKAZO_BOT: session.botId, ...(name ? { RAKAZO_NAME: name } : {}) };
}

/** Starts a command that keeps running there, such as a dev server, in `folder`. */
export async function startKeptCommand(
  session: UserComputerSession,
  input: { name: string; command: string; folder: string },
): Promise<{ name: string; running: boolean; already: boolean; output: string }> {
  const message = unsupported(session.environment);
  if (message) throw new Error(message);
  const name = processName(input.name);
  const command = input.command.trim();
  if (!command) throw new Error("Give the command to keep running.");
  const result = await runUserComputerScript(
    session,
    START,
    { ...processEnv(session, name), RAKAZO_COMMAND: command },
    input.folder,
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The command did not start.");
  const [state = "", ...rest] = result.stdout.split("\n");
  return {
    name,
    running: state === "running" || state === "already",
    already: state === "already",
    output: rest.join("\n"),
  };
}

export async function stopKeptCommand(
  session: UserComputerSession,
  name: string,
): Promise<{ name: string; stopped: boolean }> {
  const message = unsupported(session.environment);
  if (message) throw new Error(message);
  const normalized = processName(name);
  const result = await runUserComputerScript(session, STOP, processEnv(session, normalized));
  return { name: normalized, stopped: result.stdout.trim() === "stopped" };
}

export async function listKeptCommands(session: UserComputerSession): Promise<KeptCommand[]> {
  if (unsupported(session.environment)) return [];
  const result = await runUserComputerScript(session, LIST, processEnv(session));
  return result.stdout.split("\n").flatMap((line) => {
    const [name, state, ports, folder, command] = line.split("\t");
    if (!name || !USER_COMPUTER_PROCESS_NAME.test(name)) return [];
    return [
      {
        name,
        running: state === "running",
        command: command ?? "",
        folder: folder ?? "",
        ports: (ports ?? "")
          .split(" ")
          .map(Number)
          .filter((port) => Number.isInteger(port) && port > 0),
      },
    ];
  });
}

export async function keptCommandOutput(
  session: UserComputerSession,
  name: string,
): Promise<string> {
  const message = unsupported(session.environment);
  if (message) throw new Error(message);
  const result = await runUserComputerScript(session, LOGS, processEnv(session, processName(name)));
  if (result.code !== 0) throw new Error(result.stderr.trim() || "No output was kept.");
  return result.stdout;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_REQUEST_BODY = 100_000;
const MAX_RESPONSE_BODY = 60_000;
const REQUEST_SECONDS = 60;

/** An app's own address on the user's computer; anything else is refused. */
export function localAppUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Give the full address, such as http://127.0.0.1:3000/api/status.");
  }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password)
    throw new Error(
      "Only apps on the user's computer itself can be called: http://127.0.0.1 or http://localhost.",
    );
  return url.href;
}

const REQUEST = `tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
if [ -n "$RAKAZO_BODY" ]; then
  code=$(curl -sS --max-time ${REQUEST_SECONDS} -X "$RAKAZO_METHOD" -H 'accept: application/json' -H 'content-type: application/json' --data-binary "$RAKAZO_BODY" -o "$tmp" -w '%{http_code}' "$RAKAZO_URL") || exit 7
else
  code=$(curl -sS --max-time ${REQUEST_SECONDS} -X "$RAKAZO_METHOD" -H 'accept: application/json' -o "$tmp" -w '%{http_code}' "$RAKAZO_URL") || exit 7
fi
printf '%s\\n' "$code"
head -c ${MAX_RESPONSE_BODY + 1} "$tmp"`;

/**
 * Calls the HTTP API of an app running on the user's computer, such as a local studio, from that
 * computer itself. A JSON answer comes back parsed.
 */
export async function requestLocalApp(
  session: UserComputerSession,
  input: { method?: string; url: string; body?: unknown },
): Promise<{ status: number; body: unknown; truncated?: true }> {
  const message = unsupported(session.environment);
  if (message) throw new Error(message.replace("Kept commands", "Calling apps"));
  const method = (input.method ?? "GET").toUpperCase();
  if (!REQUEST_METHODS.has(method)) throw new Error("method is GET, POST, PUT, PATCH or DELETE.");
  const url = localAppUrl(input.url);
  const body =
    input.body === undefined || input.body === null || input.body === ""
      ? ""
      : typeof input.body === "string"
        ? input.body
        : JSON.stringify(input.body);
  if (body.length > MAX_REQUEST_BODY) throw new Error("The request body is too large.");
  const result = await runUserComputerScript(
    session,
    REQUEST,
    { RAKAZO_METHOD: method, RAKAZO_URL: url, RAKAZO_BODY: body },
    session.environment.home,
    (REQUEST_SECONDS + 15) * 1000,
  );
  if (result.code === 7)
    throw new Error(
      `Nothing answered at ${url}: ${result.stderr.trim() || "the app may not be running"}.`,
    );
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The request failed.");
  const newline = result.stdout.indexOf("\n");
  const status = Number(result.stdout.slice(0, newline));
  let text = result.stdout.slice(newline + 1);
  const truncated = text.length > MAX_RESPONSE_BODY;
  if (truncated) text = text.slice(0, MAX_RESPONSE_BODY);
  let parsed: unknown = text;
  if (!truncated) {
    try {
      parsed = text ? JSON.parse(text) : "";
    } catch {
      parsed = text;
    }
  }
  return { status, body: parsed, ...(truncated ? { truncated: true as const } : {}) };
}
