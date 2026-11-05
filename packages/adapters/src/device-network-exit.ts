import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  USER_DEVICE_EXIT_PATH,
  USER_DEVICE_EXIT_UNAVAILABLE,
  USER_DEVICE_TUNNEL_PATH,
  USER_DEVICE_TUNNEL_TICKET_HEADER,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import WebSocket, { WebSocketServer } from "ws";
import { pipeWebSockets } from "./socket-bridge.js";
import type { UserDeviceHub, UserDevices } from "./user-device-gateway.js";
import { validUserDeviceForwardSecret } from "./user-device-gateway.js";

/** Another API process hands a device's tunnel socket to the one holding the relay's. Not under /api. */
export const USER_DEVICE_TUNNEL_FORWARD_PATH = "/internal/user-devices/tunnel";
/** How long a relay's socket waits for the device to dial back before it goes out directly. */
const PAIRING_TIMEOUT_MS = 10_000;
const TICKET_TTL_MS = PAIRING_TIMEOUT_MS + 5_000;
/** Relayed TCP chunks, never whole files. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** Where a computer's relay reaches this server, and the key its tokens are made with. */
export interface DeviceExitOrigin {
  url: string;
  encryptionKey: string;
}

/**
 * The web origin, when a computer's relay can reach it: over HTTPS, which a public deployment
 * serves. Elsewhere (a local development origin) devices never route traffic.
 */
export function deviceExitOrigin(
  webOrigin: string | undefined,
  encryptionKey: string,
): DeviceExitOrigin | undefined {
  try {
    const url = new URL(webOrigin ?? "");
    return url.protocol === "https:" ? { url: url.origin, encryptionKey } : undefined;
  } catch {
    return undefined;
  }
}

function derivedKey(encryptionKey: string, purpose: string) {
  return createHmac("sha256", encryptionKey).update(purpose).digest();
}

/**
 * The credential a computer's network relay presents: it names the computer's home and only the
 * API can make one. It reaches the relay container, never the computer.
 */
export function deviceExitToken(encryptionKey: string, homeKey: string): string {
  const home = Buffer.from(homeKey).toString("base64url");
  const mac = createHmac("sha256", derivedKey(encryptionKey, "rakazo:device-exit:v1"))
    .update(home)
    .digest("base64url");
  return `${home}.${mac}`;
}

/** The home a relay token names, or null when the API did not make it. */
export function deviceExitHome(encryptionKey: string, header: string | null | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (!match) return null;
  const [, home, mac] = match as unknown as [string, string, string];
  const expected = createHmac("sha256", derivedKey(encryptionKey, "rakazo:device-exit:v1"))
    .update(home)
    .digest();
  const supplied = Buffer.from(mac, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return Buffer.from(home, "base64url").toString();
}

interface Ticket {
  /** The waiting relay socket. */
  tunnelId: string;
  /** The API process holding it. */
  address: string;
  deviceId: string;
  expiresAt: number;
}

/** Sealed, so the device learns nothing about the server's internal addresses. */
export function sealTunnelTicket(encryptionKey: string, ticket: Ticket): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    derivedKey(encryptionKey, "rakazo:device-exit-ticket:v1"),
    iv,
  );
  const sealed = Buffer.concat([cipher.update(JSON.stringify(ticket)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

export function openTunnelTicket(
  encryptionKey: string,
  value: string | undefined,
  now = Date.now(),
): Ticket | null {
  if (!value || value.length > 1024) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey(encryptionKey, "rakazo:device-exit-ticket:v1"),
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    const ticket = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(),
    ) as Ticket;
    return ticket.expiresAt > now ? ticket : null;
  } catch {
    return null;
  }
}

/** host:port a relay asks for, from its socket's query. */
export function tunnelTarget(url: URL): { host: string; port: number } | null {
  const host = url.searchParams.get("host") ?? "";
  const port = Number(url.searchParams.get("port"));
  if (!HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: host.replace(/^\[|\]$/g, ""), port };
}

/**
 * Joins a computer's network relay to its owner's device, one socket pair per connection. The
 * relay dials in with its computer's token; the device is asked over its own socket to dial
 * back with a sealed ticket, which may land on any API process. Bytes are only relayed: the
 * device checks and reaches the destination.
 */
export class DeviceExitRelay {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly waiting = new Map<
    string,
    { socket: WebSocket; deviceId: string; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      encryptionKey: string;
      forwardSecret: string;
      hub: UserDeviceHub;
      devices: UserDevices;
    },
  ) {}

  /** Node `upgrade` listener; false for paths it does not serve. */
  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(request.url ?? "/", "http://relay");
    const handler =
      url.pathname === USER_DEVICE_EXIT_PATH
        ? this.fromRelay
        : url.pathname === USER_DEVICE_TUNNEL_PATH
          ? this.fromDevice
          : url.pathname === USER_DEVICE_TUNNEL_FORWARD_PATH
            ? this.fromProcess
            : null;
    if (!handler) return false;
    const onError = (error: Error) => getLogger().warn("device exit upgrade error", { error });
    socket.on("error", onError);
    const reject = (status: number, text: string) =>
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const accept = (then: (ws: WebSocket) => void) => {
      socket.off("error", onError);
      this.wss.handleUpgrade(request, socket, head, then);
    };
    void handler(request, url, accept, reject).catch((error) => {
      getLogger().error("device exit upgrade failed", error);
      reject(500, "Internal Server Error");
    });
    return true;
  };

  close() {
    for (const { socket, timer } of this.waiting.values()) {
      clearTimeout(timer);
      socket.close(USER_DEVICE_EXIT_UNAVAILABLE);
    }
    this.waiting.clear();
    this.wss.close();
  }

  private fromRelay = async (
    request: IncomingMessage,
    url: URL,
    accept: (then: (ws: WebSocket) => void) => void,
    reject: (status: number, text: string) => void,
  ) => {
    const homeKey = deviceExitHome(this.deps.encryptionKey, request.headers.authorization);
    if (!homeKey) return reject(401, "Unauthorized");
    const target = tunnelTarget(url);
    if (!target) return reject(400, "Bad Request");
    const computer = await runAsSystem("find the computer a network relay serves", () =>
      this.deps.prisma.computer.findUnique({ where: { homeKey }, select: { userId: true } }),
    );
    // Accepted either way: the relay reads the close code, which a refused upgrade hides.
    accept((ws) => {
      if (!computer) return ws.close(USER_DEVICE_EXIT_UNAVAILABLE);
      const tunnelId = randomUUID();
      const timer = setTimeout(() => this.unavailable(tunnelId), PAIRING_TIMEOUT_MS);
      timer.unref();
      this.waiting.set(tunnelId, { socket: ws, deviceId: "", timer });
      ws.on("close", () => this.forget(tunnelId));
      ws.on("error", () => ws.terminate());
      const ticket = (deviceId: string) =>
        sealTunnelTicket(this.deps.encryptionKey, {
          tunnelId,
          address: this.deps.hub.address,
          deviceId,
          expiresAt: Date.now() + TICKET_TTL_MS,
        });
      void this.ask(computer.userId, tunnelId, target, ticket).catch((error) => {
        getLogger().warn("device exit request failed", { error });
        this.unavailable(tunnelId);
      });
    });
  };

  /** Finds a device that routes traffic and asks it to dial back for this tunnel. */
  private async ask(
    userId: string,
    tunnelId: string,
    target: { host: string; port: number },
    ticket: (deviceId: string) => string,
  ) {
    // The ticket names the device, so the route is read first and the message sealed for it.
    const listed = await this.deps.devices.list(userId);
    const candidates = listed.filter((device) => device.routeTraffic && device.connected);
    for (const candidate of candidates) {
      const entry = this.waiting.get(tunnelId);
      if (!entry) return;
      entry.deviceId = candidate.deviceId;
      const sent = await this.deps.devices.tunnel(
        userId,
        { type: "tunnel", ticket: ticket(candidate.deviceId), ...target },
        candidate.deviceId,
      );
      if (sent) return;
    }
    this.unavailable(tunnelId);
  }

  private fromDevice = async (
    request: IncomingMessage,
    _url: URL,
    accept: (then: (ws: WebSocket) => void) => void,
    reject: (status: number, text: string) => void,
  ) => {
    const device = await this.deps.hub.authenticate(request.headers.authorization);
    if (!device) return reject(401, "Unauthorized");
    const header = request.headers[USER_DEVICE_TUNNEL_TICKET_HEADER];
    const ticket = openTunnelTicket(
      this.deps.encryptionKey,
      typeof header === "string" ? header : undefined,
    );
    if (!ticket || ticket.deviceId !== device.id) return reject(403, "Forbidden");
    accept((ws) => {
      if (ticket.address === this.deps.hub.address) {
        this.join(ticket.tunnelId, ticket.deviceId, ws);
        return;
      }
      // The relay's socket is held by another API process: hand this one over to it.
      const peer = new URL(USER_DEVICE_TUNNEL_FORWARD_PATH, ticket.address);
      peer.protocol = peer.protocol === "https:" ? "wss:" : "ws:";
      peer.searchParams.set("id", ticket.tunnelId);
      peer.searchParams.set("device", ticket.deviceId);
      const upstream = new WebSocket(peer, {
        headers: { authorization: `Bearer ${this.deps.forwardSecret}` },
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: 5_000,
      });
      upstream.once("open", () => pipeWebSockets(ws, upstream));
      upstream.once("error", () => {
        upstream.terminate();
        ws.close(USER_DEVICE_EXIT_UNAVAILABLE);
      });
      ws.once("close", () => {
        if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      });
    });
  };

  private fromProcess = async (
    request: IncomingMessage,
    url: URL,
    accept: (then: (ws: WebSocket) => void) => void,
    reject: (status: number, text: string) => void,
  ) => {
    if (!validUserDeviceForwardSecret(this.deps.forwardSecret, request.headers.authorization))
      return reject(401, "Unauthorized");
    const tunnelId = url.searchParams.get("id") ?? "";
    const deviceId = url.searchParams.get("device") ?? "";
    accept((ws) => this.join(tunnelId, deviceId, ws));
  };

  private join(tunnelId: string, deviceId: string, device: WebSocket) {
    const entry = this.waiting.get(tunnelId);
    if (!entry || entry.deviceId !== deviceId || entry.socket.readyState !== WebSocket.OPEN) {
      device.close(USER_DEVICE_EXIT_UNAVAILABLE);
      return;
    }
    clearTimeout(entry.timer);
    this.waiting.delete(tunnelId);
    pipeWebSockets(entry.socket, device);
  }

  private unavailable(tunnelId: string) {
    const entry = this.waiting.get(tunnelId);
    if (!entry) return;
    this.forget(tunnelId);
    if (entry.socket.readyState === WebSocket.OPEN)
      entry.socket.close(USER_DEVICE_EXIT_UNAVAILABLE);
  }

  private forget(tunnelId: string) {
    const entry = this.waiting.get(tunnelId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(tunnelId);
  }
}
