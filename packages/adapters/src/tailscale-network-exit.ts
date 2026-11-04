import type { NetworkExitProvider } from "./network-exit.js";
import { splitNetworkExitValues } from "./network-exit-fields.js";

const descriptor = {
  id: "tailscale",
  displayName: "Tailscale",
  helpUrl: "https://rakazo.com/docs/own-network",
  fields: [
    { key: "authKey", label: "Auth key", kind: "secret" as const, required: true },
    { key: "exitNode", label: "Exit node", kind: "text" as const, required: true },
  ],
};

// Auth keys from the admin console look like tskey-auth-<id>-<secret>.
const AUTH_KEY = /^tskey-auth-[A-Za-z0-9]+-[A-Za-z0-9]+$/;
// A machine name, MagicDNS name or Tailscale address, as `tailscale set --exit-node` takes it.
const EXIT_NODE = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/;

export const tailscaleNetworkExit: NetworkExitProvider = {
  ...descriptor,
  verify(values) {
    const split = splitNetworkExitValues(descriptor, values);
    if (!AUTH_KEY.test(split.credentials.authKey ?? ""))
      throw new Error("Auth key must be a Tailscale auth key (tskey-auth-…)");
    if (!EXIT_NODE.test(split.settings.exitNode ?? ""))
      throw new Error("Exit node must be a machine name or Tailscale address");
    return split;
  },
};
