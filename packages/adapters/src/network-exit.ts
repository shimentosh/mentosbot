import type { NetworkExit, SecretStore } from "@rakazo/adapter-kit";
import type { NetworkExitDescriptor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { proxyNetworkExit } from "./proxy-network-exit.js";
import { tailscaleNetworkExit } from "./tailscale-network-exit.js";

export interface NetworkExitProvider extends NetworkExitDescriptor {
  /** Checks field values, splitting what may be shown again from what stays encrypted. */
  verify(values: Record<string, string>): {
    settings: Record<string, string>;
    credentials: Record<string, string>;
  };
}

export const networkExitProviders: readonly NetworkExitProvider[] = [
  tailscaleNetworkExit,
  proxyNetworkExit,
];

export function networkExitProvider(id: string): NetworkExitProvider {
  const provider = networkExitProviders.find((entry) => entry.id === id);
  if (!provider) throw new Error("Unknown network");
  return provider;
}

export function networkExitDescriptors(): NetworkExitDescriptor[] {
  return networkExitProviders.map(({ id, displayName, fields, helpUrl }) => ({
    id,
    displayName,
    fields,
    ...(helpUrl ? { helpUrl } : {}),
  }));
}

/**
 * The network exit for the computer with this home, from its owner's connection in the computer's
 * Space. Each person's computers use only their own connection.
 */
export async function loadNetworkExit(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  homeKey: string,
): Promise<NetworkExit | undefined> {
  const connection = await runAsSystem("read a computer owner's network exit", async () => {
    const computer = await prisma.computer.findUnique({
      where: { homeKey },
      select: { userId: true, spaceId: true },
    });
    if (!computer) return null;
    return prisma.computerNetworkExit.findUnique({
      where: { spaceId_userId: { spaceId: computer.spaceId, userId: computer.userId } },
      include: { secret: true },
    });
  });
  if (!connection) return undefined;
  networkExitProvider(connection.provider);
  const credentials = JSON.parse(
    await secrets.load(connection.secret.ciphertext, connection.secret.id),
  ) as Record<string, string>;
  return {
    provider: connection.provider,
    settings: Object.fromEntries(
      Object.entries((connection.settings ?? {}) as Record<string, unknown>).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    credentials,
  };
}
