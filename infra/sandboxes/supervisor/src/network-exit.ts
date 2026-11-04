import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { z } from "zod";
import { containerNameFor } from "./computer-spec.js";

/**
 * A computer's browser can reach the internet through its owner's own network. The supervisor runs
 * that network in a separate container on the computer's private network, so its credentials stay
 * out of the computer: the computer only sees a proxy address.
 */
const TailscaleExitSchema = z.object({
  provider: z.literal("tailscale"),
  // It goes into tailscale's arguments, so it may hold no spaces and never start a flag.
  settings: z.object({
    exitNode: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/),
  }),
  credentials: z.object({ authKey: z.string().min(1).max(4096) }),
});
// These go into the forwarder's configuration: no whitespace, quotes or separators.
const PROXY_WORD = /^[^\s:"\\]{1,256}$/;
const ProxyExitSchema = z.object({
  provider: z.literal("proxy"),
  settings: z.object({
    address: z
      .string()
      .regex(/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):\d{1,5}$/),
    username: z.string().regex(PROXY_WORD).optional(),
  }),
  credentials: z.object({ password: z.string().regex(PROXY_WORD).optional() }),
});
export const NetworkExitSchema = z.discriminatedUnion("provider", [
  TailscaleExitSchema,
  ProxyExitSchema,
]);
export type NetworkExit = z.infer<typeof NetworkExitSchema>;

/** Official image, pinned by digest; override for mirrors with SANDBOX_NETWORK_EXIT_IMAGE. */
export const DEFAULT_NETWORK_EXIT_IMAGE =
  "docker.io/tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c";
/** Canonical's Squid, pinned by digest; override for mirrors with SANDBOX_NETWORK_PROXY_IMAGE. */
export const DEFAULT_NETWORK_PROXY_IMAGE =
  "docker.io/ubuntu/squid:6.6-24.04_beta@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
export const NETWORK_EXIT_LABEL = "rakazo.network-exit";
/**
 * The exit container's owner. Deliberately not `rakazo.botId`: lookups by that label must only
 * ever find the computer itself.
 */
export const NETWORK_EXIT_BOT_LABEL = "rakazo.network-exit.botId";
/** The name the computer reaches the network container by, on its own network only. */
export const NETWORK_EXIT_ALIAS = "rakazo-network-exit";
export const NETWORK_EXIT_PROXY_PORT = 1055;
const FORWARDER_PORT = 3128;

/** Where the computer's browser sends its traffic for each kind of exit. */
export function networkExitProxy(exit: NetworkExit): string {
  return exit.provider === "proxy"
    ? `http://${NETWORK_EXIT_ALIAS}:${FORWARDER_PORT}`
    : `socks5://${NETWORK_EXIT_ALIAS}:${NETWORK_EXIT_PROXY_PORT}`;
}

/** Changes whenever anything about the exit does, so a computer and its exit are replaced together. */
export function networkExitFingerprint(exit: NetworkExit | undefined): string | undefined {
  if (!exit) return undefined;
  return createHash("sha256").update(JSON.stringify(exit)).digest("hex").slice(0, 32);
}

export function networkExitContainerName(botId: string) {
  return `${containerNameFor(botId)}-network`;
}

/** Valid as a Tailscale machine name: letters, digits and dashes, at most 63. */
function machineName(botId: string) {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `rakazo-${hash}`;
}

export function networkExitContainerOptions(input: {
  botId: string;
  image: string;
  networkMode: string;
  exit: NetworkExit;
}): Docker.ContainerCreateOptions {
  const fingerprint = networkExitFingerprint(input.exit)!;
  const isolated = {
    NetworkMode: input.networkMode,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    ReadonlyRootfs: true,
    Memory: 256 * 1024 * 1024,
    PidsLimit: 128,
  };
  const shared = {
    Image: input.image,
    name: networkExitContainerName(input.botId),
    Labels: { [NETWORK_EXIT_BOT_LABEL]: input.botId, [NETWORK_EXIT_LABEL]: fingerprint },
    NetworkingConfig: {
      EndpointsConfig: { [input.networkMode]: { Aliases: [NETWORK_EXIT_ALIAS] } },
    },
  };
  if (input.exit.provider === "proxy") {
    return {
      ...shared,
      // The configuration, with the password, lives only in this container's environment.
      User: "proxy",
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ['printf "%s\\n" "$SQUID_CONF" > /tmp/squid.conf && exec squid -N -f /tmp/squid.conf'],
      Env: [`SQUID_CONF=${squidConfig(input.exit)}`],
      HostConfig: {
        ...isolated,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m", "/run": "rw,noexec,nosuid,size=1m" },
      },
    };
  }
  return {
    ...shared,
    Env: [
      `TS_AUTHKEY=${input.exit.credentials.authKey}`,
      `TS_HOSTNAME=${machineName(input.botId)}`,
      // Userspace networking needs no TUN device or capabilities, and its SOCKS5 proxy carries
      // the browser's traffic out through the exit node.
      "TS_USERSPACE=true",
      `TS_SOCKS5_SERVER=:${NETWORK_EXIT_PROXY_PORT}`,
      "TS_ACCEPT_DNS=false",
      // No TS_STATE_DIR: state stays in memory, so every start is a fresh machine, which an
      // ephemeral key removes from the tailnet once it goes offline.
      // Nothing on the tailnet may connect in, and the computer's traffic leaves by the exit node.
      `TS_EXTRA_ARGS=--shields-up --exit-node=${input.exit.settings.exitNode} --exit-node-allow-lan-access=false`,
    ],
    HostConfig: {
      ...isolated,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m", "/var/run/tailscale": "rw,nosuid,size=1m" },
    },
  };
}

/**
 * A forwarder that sends everything to the person's proxy and never anywhere directly, so a
 * proxy that is down fails closed. It caches and logs nothing.
 */
export function squidConfig(exit: Extract<NetworkExit, { provider: "proxy" }>): string {
  const [, host, port] = /^(.*):(\d+)$/.exec(exit.settings.address)!;
  const login =
    exit.settings.username && exit.credentials.password
      ? ` login=${exit.settings.username}:${exit.credentials.password}`
      : "";
  return [
    `http_port ${FORWARDER_PORT}`,
    "http_access allow all",
    `cache_peer ${host!.replace(/^\[|\]$/g, "")} parent ${port} 0 no-query no-digest default${login}`,
    "never_direct allow all",
    "cache deny all",
    "cache_mem 0 MB",
    "access_log none",
    "cache_log stdio:/dev/stderr",
    "pid_filename /tmp/squid.pid",
    "coredump_dir /tmp",
    "forwarded_for delete",
    "via off",
    // Unprivileged and offline-quiet: no ICMP probes of the peer.
    "pinger_enable off",
  ].join("\n");
}

/** The computer's side: only where to send browser traffic, and which exit it was made for. */
export function computerNetworkExitSettings(exit: NetworkExit | undefined): {
  env: string[];
  labels: Record<string, string>;
} {
  const fingerprint = networkExitFingerprint(exit);
  return fingerprint
    ? {
        env: [`RAKAZO_BROWSER_PROXY=${networkExitProxy(exit!)}`],
        labels: { [NETWORK_EXIT_LABEL]: fingerprint },
      }
    : { env: [], labels: {} };
}
