import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, createServer } from "node:net";
import {
  USER_DEVICE_EXIT_PATH,
  USER_DEVICE_EXIT_READY,
  USER_DEVICE_EXIT_UNAVAILABLE,
  USER_DEVICE_EXIT_UNREACHABLE,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  DeviceExitRelay,
  deviceExitHome,
  deviceExitOrigin,
  deviceExitToken,
  openTunnelTicket,
  sealTunnelTicket,
  tunnelTarget,
} from "./device-network-exit.js";
import { carryablePort, createDeviceTunnels, publicAddress } from "./device-tunnel.js";
import type { UserDeviceHub, UserDevices } from "./user-device-gateway.js";
import type { UserDeviceNotice } from "./user-device-protocol.js";

const KEY = "test-encryption-key-at-least-thirty-two-chars";
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("relay tokens and tickets", () => {
  it("names the computer's home and cannot be made without the key", () => {
    const token = deviceExitToken(KEY, "home:team/space-1");
    expect(deviceExitHome(KEY, `Bearer ${token}`)).toBe("home:team/space-1");
    expect(
      deviceExitHome("another-key-that-is-also-thirty-two-chars", `Bearer ${token}`),
    ).toBeNull();
    const [home] = token.split(".");
    const forged = deviceExitToken(KEY, "other-home").split(".")[1];
    expect(deviceExitHome(KEY, `Bearer ${home}.${forged}`)).toBeNull();
    expect(deviceExitHome(KEY, token)).toBeNull();
  });

  it("seals tickets so the device cannot read or change them, and expires them", () => {
    const ticket = {
      tunnelId: "t1",
      address: "http://10.0.0.5:3100",
      deviceId: "d1",
      expiresAt: 2_000,
    };
    const sealed = sealTunnelTicket(KEY, ticket);
    expect(sealed).not.toContain("10.0.0.5");
    expect(openTunnelTicket(KEY, sealed, 1_000)).toEqual(ticket);
    expect(openTunnelTicket(KEY, sealed, 3_000)).toBeNull();
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
    expect(openTunnelTicket(KEY, tampered, 1_000)).toBeNull();
  });

  it("only routes through a public HTTPS origin", () => {
    expect(deviceExitOrigin("https://app.example.com/", KEY)).toEqual({
      url: "https://app.example.com",
      encryptionKey: KEY,
    });
    expect(deviceExitOrigin("http://127.0.0.1:5173", KEY)).toBeUndefined();
    expect(deviceExitOrigin(undefined, KEY)).toBeUndefined();
  });

  it("accepts only a host and port as the target", () => {
    const target = (query: string) => tunnelTarget(new URL(`http://x/?${query}`));
    expect(target("host=example.com&port=443")).toEqual({ host: "example.com", port: 443 });
    expect(target("host=[2001:db8::1]&port=80")).toEqual({ host: "2001:db8::1", port: 80 });
    expect(target("host=example.com&port=0")).toBeNull();
    expect(target("host=a b&port=80")).toBeNull();
  });
});

describe("the device side", () => {
  it("reaches only addresses that are all public", async () => {
    const lookup = (addresses: string[]) => async () => addresses;
    expect(await publicAddress("example.com", lookup(["93.184.216.34"]))).toBe("93.184.216.34");
    expect(await publicAddress("example.com", lookup(["93.184.216.34", "192.168.1.1"]))).toBeNull();
    expect(await publicAddress("router.local", lookup(["93.184.216.34"]))).toBeNull();
    expect(await publicAddress("10.0.0.1")).toBeNull();
    expect(await publicAddress("169.254.169.254")).toBeNull();
    expect(await publicAddress("localhost")).toBeNull();
  });

  it("carries web ports only, never mail or remote login", () => {
    for (const port of [80, 443, 1024, 8080, 8443])
      expect(carryablePort(port), `${port}`).toBe(true);
    for (const port of [22, 25, 465, 587, 445, 1023])
      expect(carryablePort(port), `${port}`).toBe(false);
  });
});

/** An echo server standing in for a website, reached as if it were at a public address. */
async function echoServer() {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

async function relayServer(options: { computer?: boolean; deviceOnline?: boolean } = {}) {
  const echoPort = await echoServer();
  const http = createHttpServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const deviceToken = "a".repeat(64);
  let tunnels: ReturnType<typeof createDeviceTunnels> | undefined;
  const notices: UserDeviceNotice[] = [];
  const hub = {
    address: origin,
    authenticate: async (header: string | undefined) =>
      header === `Bearer ${deviceToken}`
        ? { id: "device-1", userId: "user-1", name: "Laptop", platform: "darwin" }
        : null,
  } as unknown as UserDeviceHub;
  const devices = {
    list: async () => [
      {
        deviceId: "device-1",
        name: "Laptop",
        connected: options.deviceOnline !== false,
        routeTraffic: true,
      },
    ],
    tunnel: async (_userId: string, notice: UserDeviceNotice) => {
      notices.push(notice);
      tunnels?.carry(notice);
      return true;
    },
  } as unknown as UserDevices;
  const prisma = {
    computer: {
      findUnique: async () => (options.computer === false ? null : { userId: "user-1" }),
    },
  } as unknown as PrismaClient;
  const relay = new DeviceExitRelay({
    prisma,
    encryptionKey: KEY,
    forwardSecret: "forward-secret",
    hub,
    devices,
  });
  http.on("upgrade", (request, socket, head) => {
    if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
  });
  tunnels = createDeviceTunnels({
    serverUrl: origin,
    token: deviceToken,
    // The website is "public"; the test reaches it on loopback.
    lookup: async () => ["93.184.216.34"],
    connect: (_host, port) => connect({ host: "127.0.0.1", port: port === 2000 ? 1 : echoPort }),
  });
  closers.push(() => {
    tunnels?.closeAll();
    relay.close();
    return new Promise((resolve) => http.close(resolve));
  });
  const open = (target: string, token = deviceExitToken(KEY, "home-1")) =>
    new WebSocket(`${origin.replace("http", "ws")}${USER_DEVICE_EXIT_PATH}?${target}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  return { open, notices };
}

function firstEvent(ws: WebSocket) {
  return new Promise<{ message?: string; close?: number; status?: number }>((resolve) => {
    ws.once("message", (data, isBinary) =>
      resolve({ message: isBinary ? "binary" : String(data) }),
    );
    ws.once("close", (code) => resolve({ close: code }));
    ws.once("unexpected-response", (_request, response) =>
      resolve({ status: response.statusCode }),
    );
  });
}

describe("a computer connection through the owner's device", () => {
  it("carries bytes both ways once the device reached the destination", async () => {
    const { open, notices } = await relayServer();
    const ws = open("host=example.com&port=443");
    expect(await firstEvent(ws)).toEqual({ message: USER_DEVICE_EXIT_READY });
    expect(notices).toEqual([expect.objectContaining({ host: "example.com", port: 443 })]);
    const echoed = new Promise<string>((resolve) =>
      ws.once("message", (data) => resolve(String(data))),
    );
    ws.send(Buffer.from("hello through home"), { binary: true });
    expect(await echoed).toBe("hello through home");
    ws.close();
  });

  it("tells the relay to go out directly when no device is online", async () => {
    const { open, notices } = await relayServer({ deviceOnline: false });
    expect(await firstEvent(open("host=example.com&port=443"))).toEqual({
      close: USER_DEVICE_EXIT_UNAVAILABLE,
    });
    expect(notices).toEqual([]);
  });

  it("says when the device could not reach the destination", async () => {
    const { open } = await relayServer();
    expect(await firstEvent(open("host=example.com&port=2000"))).toEqual({
      close: USER_DEVICE_EXIT_UNREACHABLE,
    });
    // Mail never leaves from the owner's address, even when the server asks.
    expect(await firstEvent(open("host=example.com&port=25"))).toEqual({
      close: USER_DEVICE_EXIT_UNREACHABLE,
    });
  });

  it("refuses a relay without a valid token, and one for a computer that is gone", async () => {
    const { open } = await relayServer();
    expect(await firstEvent(open("host=example.com&port=443", "home.forged"))).toEqual({
      status: 401,
    });
    const gone = await relayServer({ computer: false });
    expect(await firstEvent(gone.open("host=example.com&port=443"))).toEqual({
      close: USER_DEVICE_EXIT_UNAVAILABLE,
    });
  });
});
