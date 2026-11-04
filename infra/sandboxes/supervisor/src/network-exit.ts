import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { z } from "zod";
import { containerNameFor } from "./computer-spec.js";

/**
 * A computer's browser can reach the internet through its owner's own network. The supervisor runs
 * that network in a separate container on the computer's private network, so its credentials stay
 * out of the computer: the computer only sees a proxy address.
 */
export const NetworkExitSchema = z.object({
  provider: z.literal("tailscale"),
  // It goes into tailscale's arguments, so it may hold no spaces and never start a flag.
  settings: z.object({
    exitNode: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/),
  }),
  credentials: z.object({ authKey: z.string().min(1).max(4096) }),
});
export type NetworkExit = z.infer<typeof NetworkExitSchema>;

/** Official image, pinned by digest; override for mirrors with SANDBOX_NETWORK_EXIT_IMAGE. */
export const DEFAULT_NETWORK_EXIT_IMAGE =
  "docker.io/tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c";
export const NETWORK_EXIT_LABEL = "rakazo.network-exit";
/**
 * The exit container's owner. Deliberately not `rakazo.botId`: lookups by that label must only
 * ever find the computer itself.
 */
export const NETWORK_EXIT_BOT_LABEL = "rakazo.network-exit.botId";
/** The name the computer reaches the network container by, on its own network only. */
export const NETWORK_EXIT_ALIAS = "rakazo-network-exit";
export const NETWORK_EXIT_PROXY_PORT = 1055;
export const NETWORK_EXIT_PROXY = `socks5://${NETWORK_EXIT_ALIAS}:${NETWORK_EXIT_PROXY_PORT}`;

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
  return {
    Image: input.image,
    name: networkExitContainerName(input.botId),
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
    Labels: {
      [NETWORK_EXIT_BOT_LABEL]: input.botId,
      [NETWORK_EXIT_LABEL]: fingerprint,
    },
    HostConfig: {
      NetworkMode: input.networkMode,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m", "/var/run/tailscale": "rw,nosuid,size=1m" },
      Memory: 256 * 1024 * 1024,
      PidsLimit: 128,
    },
    NetworkingConfig: {
      EndpointsConfig: { [input.networkMode]: { Aliases: [NETWORK_EXIT_ALIAS] } },
    },
  };
}

/** The computer's side: only where to send browser traffic, and which exit it was made for. */
export function computerNetworkExitSettings(exit: NetworkExit | undefined): {
  env: string[];
  labels: Record<string, string>;
} {
  const fingerprint = networkExitFingerprint(exit);
  return fingerprint
    ? {
        env: [`RAKAZO_BROWSER_PROXY=${NETWORK_EXIT_PROXY}`],
        labels: { [NETWORK_EXIT_LABEL]: fingerprint },
      }
    : { env: [], labels: {} };
}
