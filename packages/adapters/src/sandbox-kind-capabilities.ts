import type { SandboxKindCapabilities } from "@rakazo/adapter-kit";
import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import { SERVER_COMPUTER_KIND } from "@rakazo/db";
import { computerProviders, isKnownSandboxKind, knownSandboxKinds } from "./computer-providers.js";

export type { KnownSandboxKind } from "./computer-providers.js";
export { isKnownSandboxKind, knownSandboxKinds };

/** A stored kind no provider declares anymore reads as a plain remote Linux computer. */
const UNDECLARED_KIND_CAPABILITIES: SandboxKindCapabilities = {
  terminal: false,
  inPlaceUpdate: true,
  nativeShell: false,
  runsOnUserMachine: false,
  screen: DEFAULT_COMPUTER_SCREEN,
  serverHomeMount: "never",
  serverOwnsStoredTeamHome: false,
  storedHomeIsBackup: false,
};

/**
 * A Docker computer on one of an organization's own servers. The server pool places it rather
 * than a provider of its own; its home is copied in and saved back like a remote computer's.
 */
const SERVER_KIND_CAPABILITIES: SandboxKindCapabilities = {
  ...UNDECLARED_KIND_CAPABILITIES,
  terminal: true,
};

/**
 * Read by the computer's own kind, never from the deployment's provider: one deployment can
 * run computers of several kinds.
 */
export function sandboxKindCapabilities(kind: string | null | undefined): SandboxKindCapabilities {
  if (kind === SERVER_COMPUTER_KIND) return SERVER_KIND_CAPABILITIES;
  return isKnownSandboxKind(kind)
    ? computerProviders[kind].capabilities
    : UNDECLARED_KIND_CAPABILITIES;
}

export function sandboxKindsWhere(
  matches: (capabilities: SandboxKindCapabilities) => boolean,
): string[] {
  return knownSandboxKinds.filter((kind) => matches(computerProviders[kind].capabilities));
}
