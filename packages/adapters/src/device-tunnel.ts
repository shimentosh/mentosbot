import { lookup as dnsLookup } from "node:dns/promises";
import type { Socket } from "node:net";
import { connect as netConnect } from "node:net";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
  USER_DEVICE_EXIT_READY,
  USER_DEVICE_EXIT_UNAVAILABLE,
  USER_DEVICE_EXIT_UNREACHABLE,
  USER_DEVICE_TUNNEL_PATH,
  USER_DEVICE_TUNNEL_TICKET_HEADER,
} from "@rakazo/contracts";
import WebSocket from "ws";
import { bridgeSocket } from "./socket-bridge.js";
import type { UserDeviceNotice } from "./user-device-protocol.js";

/** Connections one device carries at once; past this the computer goes out directly. */
const MAX_TUNNELS = 256;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

type Lookup = (host: string) => Promise<string[]>;

const lookupAll: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Web ports only. Below 1024 sit mail, file sharing and remote login, which would let a bot send
 * mail or reach other services from the owner's own address.
 */
export function carryablePort(port: number) {
  return port === 80 || port === 443 || (port >= 1024 && port <= 65535);
}

/**
 * The address to reach for a host, only when every address it has is public: a bot must never
 * reach this computer's own network, its router, or a cloud metadata service through it.
 */
export async function publicAddress(host: string, lookup: Lookup = lookupAll) {
  if (isInternalHostname(host) || isCloudMetadataHost(host)) return null;
  const addresses = ipVersion(host) ? [host] : await lookup(host).catch(() => []);
  if (!addresses.length || addresses.some((address) => isNonPublicAddress(address))) return null;
  return addresses[0]!;
}

/**
 * Carries the owner's computer connections from this device's own network. The server only
 * relays bytes; this side picks the address it connects to.
 */
export function createDeviceTunnels(options: {
  serverUrl: string;
  token: string;
  lookup?: Lookup;
  connect?: (host: string, port: number) => Socket;
}) {
  const lookup = options.lookup ?? lookupAll;
  const connect = options.connect ?? ((host, port) => netConnect({ host, port }));
  const url = new URL(USER_DEVICE_TUNNEL_PATH, options.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const live = new Set<{ ws: WebSocket; tcp?: Socket }>();

  function carry(notice: UserDeviceNotice) {
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${options.token}`,
        [USER_DEVICE_TUNNEL_TICKET_HEADER]: notice.ticket,
      },
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    const entry: { ws: WebSocket; tcp?: Socket } = { ws };
    const full = live.size >= MAX_TUNNELS;
    live.add(entry);
    ws.on("close", () => {
      live.delete(entry);
      entry.tcp?.destroy();
    });
    ws.on("error", () => ws.terminate());
    ws.on("unexpected-response", (request) => {
      request.destroy();
      ws.terminate();
    });
    const opened = new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("close", () => resolve(false));
    });
    const refuse = (code: number) =>
      void opened.then((open) => {
        if (open) ws.close(code);
      });
    if (full) return refuse(USER_DEVICE_EXIT_UNAVAILABLE);
    void (async () => {
      const address = carryablePort(notice.port) ? await publicAddress(notice.host, lookup) : null;
      if (!address) return refuse(USER_DEVICE_EXIT_UNREACHABLE);
      const tcp = connect(address, notice.port);
      entry.tcp = tcp;
      const timer = setTimeout(() => tcp.destroy(), CONNECT_TIMEOUT_MS);
      const reached = await new Promise<boolean>((resolve) => {
        tcp.once("connect", () => resolve(true));
        tcp.once("error", () => resolve(false));
        tcp.once("close", () => resolve(false));
      });
      clearTimeout(timer);
      if (!reached) return refuse(USER_DEVICE_EXIT_UNREACHABLE);
      if (!(await opened)) return tcp.destroy();
      ws.send(USER_DEVICE_EXIT_READY);
      bridgeSocket(ws, tcp);
    })();
  }

  return {
    carry,
    closeAll() {
      for (const { ws, tcp } of live) {
        tcp?.destroy();
        ws.terminate();
      }
      live.clear();
    },
  };
}
