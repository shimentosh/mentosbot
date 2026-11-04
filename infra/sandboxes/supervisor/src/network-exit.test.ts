import { describe, expect, it } from "vitest";
import { containerCreateOptions } from "./computer-spec.js";
import {
  computerNetworkExitSettings,
  NETWORK_EXIT_BOT_LABEL,
  NETWORK_EXIT_LABEL,
  NetworkExitSchema,
  networkExitContainerOptions,
  networkExitFingerprint,
  squidConfig,
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

describe("proxy network exit", () => {
  const exit = {
    provider: "proxy" as const,
    settings: { address: "proxy.example.com:8080", username: "me" },
    credentials: { password: "s3cret" },
  };

  it("sends everything to the person's proxy and nowhere directly", () => {
    const config = squidConfig(exit);
    expect(config).toContain(
      "cache_peer proxy.example.com parent 8080 0 no-query no-digest default login=me:s3cret",
    );
    expect(config).toContain("never_direct allow all");
    expect(config).toContain("cache deny all");
  });

  it("keeps the password in the forwarder, never the computer", () => {
    const settings = computerNetworkExitSettings(exit);
    expect(settings.env).toEqual(["RAKAZO_BROWSER_PROXY=http://rakazo-network-exit:3128"]);
    expect(JSON.stringify(settings)).not.toContain("s3cret");
    const options = networkExitContainerOptions({
      botId: "b1",
      image: "squid",
      networkMode: "rakazo-computer-b1",
      exit,
    });
    expect(options).toMatchObject({
      User: "proxy",
      HostConfig: { CapDrop: ["ALL"], ReadonlyRootfs: true, NetworkMode: "rakazo-computer-b1" },
    });
    expect(options.Env?.[0]).toContain("login=me:s3cret");
  });

  it("refuses values that could change the forwarder's configuration", () => {
    for (const settings of [
      { address: "proxy.example.com:8080\nhttp_port 9" },
      { address: "proxy.example.com:8080", username: "me\nnever_direct deny all" },
    ])
      expect(NetworkExitSchema.safeParse({ ...exit, settings }).success).toBe(false);
  });
});
