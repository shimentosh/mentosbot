import type { SandboxProvider } from "@rakazo/adapter-kit";
import { SERVER_COMPUTER_KIND } from "@rakazo/db";
import { NoneSandboxProvider } from "../../providers/computer/none/none-sandbox.js";
import type { SandboxProviderOptions } from "../computer-provider-descriptor.js";
import { envBindings } from "../computer-provider-descriptor.js";
import { computerProviders, isKnownSandboxKind, knownSandboxKinds } from "../computer-providers.js";

export type { SandboxProviderOptions } from "../computer-provider-descriptor.js";

export async function createSandboxProvider(
  kind: string,
  opts: SandboxProviderOptions,
): Promise<SandboxProvider> {
  if (kind === "") return new NoneSandboxProvider();
  // The server pool places computers on an organization's own servers; no deployment runs as one.
  if (kind === SERVER_COMPUTER_KIND) {
    return new NoneSandboxProvider(
      "Computers unavailable: an organization adds its own servers in Settings; set SANDBOX_PROVIDER=docker.",
    );
  }
  if (!isKnownSandboxKind(kind)) {
    throw new Error(`Unknown SANDBOX_PROVIDER "${kind}". Use ${knownSandboxKinds.join(" | ")}.`);
  }
  const provider = computerProviders[kind];
  const missing = envBindings(provider).find(
    ([option, binding]) => binding.required && !(opts[option] as string | undefined)?.trim(),
  );
  if (missing) {
    return new NoneSandboxProvider(
      `Computers unavailable: ${missing[1].name} is required for SANDBOX_PROVIDER=${kind}.`,
    );
  }
  return provider.create(opts);
}
