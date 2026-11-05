import { createHash } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { isLocalhostOrLoopbackIp, isPrivateNetworkAddress } from "@rakazo/contracts";
import type { Client, ClientChannel } from "ssh2";

/** A setup failure whose message is safe to show the admin who started it. */
export class ServerSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerSetupError";
  }
}

const INSTALL_TIMEOUT_MS = 40 * 60_000;
const STEP_TIMEOUT_MS = 60_000;
const REMOTE_SCRIPT = "/tmp/rakazo-server-install.sh";

/** Interfaces Docker and loopback create; never the server's own network. */
const VIRTUAL_INTERFACE = /^(lo|docker\d*|br-|veth|virbr|cni|flannel|cali|kube)/;

/**
 * Private addresses of the server, from `ip -o addr show`: the ones another machine on the same
 * cloud network or VPN could reach it at.
 */
export function privateAddresses(ipAddrOutput: string): string[] {
  const found: string[] = [];
  for (const line of ipAddrOutput.split("\n")) {
    const match = /^\d+:\s+(\S+)\s+inet6?\s+([^\s/]+)/.exec(line.trim());
    if (!match) continue;
    const [, name, address] = match as unknown as [string, string, string];
    if (VIRTUAL_INTERFACE.test(name.replace(/@.*$/, ""))) continue;
    if (!isPrivateNetworkAddress(address) || isLocalhostOrLoopbackIp(address)) continue;
    if (!found.includes(address)) found.push(address);
  }
  return found;
}

/** Whether this machine reaches the address on the given port within a few seconds. */
export function reachesAddress(address: string, port: number, timeoutMs = 3_000) {
  return new Promise<boolean>((resolve) => {
    const socket = connectTcp({ host: address, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(
  client: Client,
  command: string,
  options: { stdin?: string; timeoutMs: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
      if (error) return reject(error);
      let output = "";
      const keep = (chunk: Buffer) => {
        // The last lines are enough to say what went wrong.
        output = (output + chunk.toString("utf8")).slice(-4_000);
      };
      const timer = setTimeout(() => {
        stream.close();
        reject(new ServerSetupError("Setup took too long"));
      }, options.timeoutMs);
      stream.on("data", keep);
      stream.stderr.on("data", keep);
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
      if (options.stdin !== undefined) stream.end(options.stdin);
      else stream.end();
    });
  });
}

function lastLine(output: string) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, 300) ?? "";
}

export interface ServerSetupRequest {
  host: string;
  port?: number;
  username: string;
  password: string;
  token: string;
  script: string;
  /** Checks a private address of the server is reachable from here before using it. */
  reachable?: (address: string) => Promise<boolean>;
  /** Builds the SSH client; tests replace it. */
  client?: () => Promise<Client>;
}

/**
 * Signs in to a fresh server with a password, finds the private address this machine reaches it
 * at, and runs the setup script there as root. The password is used for this sign-in only.
 */
export async function setUpServerOverSsh(
  request: ServerSetupRequest,
): Promise<{ address: string; hostKey: string }> {
  const client = request.client
    ? await request.client()
    : new (await import("ssh2")).default.Client();
  let hostKey = "";
  await new Promise<void>((resolve, reject) => {
    client.once("ready", () => resolve());
    client.once("error", (error: Error & { level?: string }) =>
      reject(
        new ServerSetupError(
          error.level === "client-authentication"
            ? "The server refused this username or password"
            : "Couldn't connect to the server over SSH",
        ),
      ),
    );
    client.connect({
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      password: request.password,
      readyTimeout: 20_000,
      // A new server has no key on record yet; keep its fingerprint so the admin can check it.
      hostVerifier: (key: Buffer) => {
        hostKey = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
        return true;
      },
    });
  });
  try {
    const addresses = await run(client, "ip -o addr show", { timeoutMs: STEP_TIMEOUT_MS });
    const reachable = request.reachable ?? ((address: string) => reachesAddress(address, 22));
    let address: string | undefined;
    for (const candidate of privateAddresses(addresses.output))
      if (await reachable(candidate)) {
        address = candidate;
        break;
      }
    if (!address)
      throw new ServerSetupError(
        "This server shares no private network with Rakazo's server. Put both in the same private network or VPN.",
      );
    const upload = await run(client, `umask 077 && cat > ${REMOTE_SCRIPT}`, {
      stdin: request.script,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (upload.code !== 0) throw new ServerSetupError("Couldn't copy the setup script");
    const args = `${REMOTE_SCRIPT} --token ${shellQuote(request.token)} --address ${shellQuote(address)}`;
    const asRoot = request.username === "root";
    const install = await run(client, asRoot ? `bash ${args}` : `sudo -S -p '' bash ${args}`, {
      stdin: asRoot ? undefined : `${request.password}\n`,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    await run(client, `rm -f ${REMOTE_SCRIPT}`, { timeoutMs: STEP_TIMEOUT_MS }).catch(() => {});
    if (install.code !== 0)
      throw new ServerSetupError(lastLine(install.output) || "Setup failed on the server");
    return { address, hostKey };
  } finally {
    client.end();
  }
}
