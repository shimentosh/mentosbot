import { describe, expect, it } from "vitest";
import { containerCreateOptions } from "./computer-spec.js";
import {
  computerNetworkExitSettings,
  NETWORK_EXIT_BOT_LABEL,
  NETWORK_EXIT_LABEL,
  NetworkExitSchema,
  networkExitContainerOptions,
  networkExitFingerprint,
} from "./network-exit.js";

const exit = {
  provider: "tailscale" as const,
  settings: { exitNode: "pixel-7" },
  credentials: { authKey: "tskey-auth-fake-0123456789" },
};

describe("computer network exit", () => {
  it("gives the computer only a proxy address, never the credentials", () => {
    const settings = computerNetworkExitSettings(exit);
    const computer = containerCreateOptions({
      name: "rakazo-bot-b1",
      image: "rakazo/computer",
      botId: "b1",
      spaceId: "s1",
      homePath: "/data/home",
      networkMode: "rakazo-computer-b1",
      ...settings,
    });
    expect(computer.Env).toContain("RAKAZO_BROWSER_PROXY=socks5://rakazo-network-exit:1055");
    expect(JSON.stringify(computer)).not.toContain(exit.credentials.authKey);
    expect((computer.Labels as Record<string, string>)[NETWORK_EXIT_LABEL]).toBe(
      networkExitFingerprint(exit),
    );
    expect(computerNetworkExitSettings(undefined)).toEqual({ env: [], labels: {} });
  });

  it("runs the network beside the computer, unprivileged and reachable only on its network", () => {
    const options = networkExitContainerOptions({
      botId: "b1",
      image: "tailscale",
      networkMode: "rakazo-computer-b1",
      exit,
    });
    expect(options.Env).toEqual(
      expect.arrayContaining([
        `TS_AUTHKEY=${exit.credentials.authKey}`,
        "TS_USERSPACE=true",
        "TS_EXTRA_ARGS=--shields-up --exit-node=pixel-7 --exit-node-allow-lan-access=false",
      ]),
    );
    expect(options.HostConfig).toMatchObject({
      NetworkMode: "rakazo-computer-b1",
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
    });
    expect(options.HostConfig?.PortBindings).toBeUndefined();
    // Lookups of a bot's computer by its label must never find the exit container.
    expect(options.Labels).not.toHaveProperty("rakazo.botId");
    expect(options.Labels?.[NETWORK_EXIT_BOT_LABEL]).toBe("b1");
  });

  it("refuses exit nodes that could add arguments", () => {
    for (const exitNode of ["pixel-7 --advertise-exit-node", "--accept-routes", "a b"])
      expect(
        NetworkExitSchema.safeParse({ ...exit, settings: { exitNode } }).success,
        exitNode,
      ).toBe(false);
    expect(NetworkExitSchema.safeParse(exit).success).toBe(true);
  });

  it("changes the fingerprint with any change, so the computer is replaced", () => {
    const moved = { ...exit, settings: { exitNode: "apple-tv" } };
    const rekeyed = { ...exit, credentials: { authKey: "tskey-auth-other-9" } };
    expect(new Set([exit, moved, rekeyed].map(networkExitFingerprint)).size).toBe(3);
  });
});
