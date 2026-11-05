import type { NetworkExit, SecretStore } from "@rakazo/adapter-kit";
import type { NetworkExitDescriptor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { DeviceExitOrigin } from "./device-network-exit.js";
import { deviceExitToken } from "./device-network-exit.js";
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
 * Space. Each person's computers use only their own connection. Without one, a device of the
 * owner's that routes traffic carries the browser's connections while it is online.
 */
export async function loadNetworkExit(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  homeKey: string,
  deviceExit?: DeviceExitOrigin,
): Promise<NetworkExit | undefined> {
  const { connection, routesTraffic, owner } = await runAsSystem(
    "read a computer owner's network exit",
    async () => {
      const computer = await prisma.computer.findUnique({
        where: { homeKey },
        select: { userId: true, spaceId: true },
      });
      if (!computer) return { connection: null, routesTraffic: false, owner: null };
      const [connection, devices, owner] = await Promise.all([
        prisma.computerNetworkExit.findUnique({
          where: { spaceId_userId: { spaceId: computer.spaceId, userId: computer.userId } },
          include: { secret: true },
        }),
        deviceExit
          ? prisma.userDevice.count({
              where: { userId: computer.userId, revokedAt: null, routeTraffic: true },
            })
          : 0,
        prisma.user.findUnique({
          where: { id: computer.userId },
          select: { timezone: true, locale: true },
        }),
      ]);
      return { connection, routesTraffic: devices > 0, owner };
    },
  );
  const browser =
    owner?.timezone || owner?.locale
      ? {
          browser: {
            ...(owner.timezone ? { timeZone: owner.timezone } : {}),
            ...(owner.locale ? { locale: owner.locale } : {}),
          },
        }
      : {};
  if (!connection) {
    return deviceExit && routesTraffic
      ? {
          provider: "device",
          settings: { url: deviceExit.url },
          credentials: { token: deviceExitToken(deviceExit.encryptionKey, homeKey) },
          ...browser,
        }
      : undefined;
  }
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
    ...browser,
  };
}
