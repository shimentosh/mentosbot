// The network relay beside a computer whose owner routes traffic through their own device. The
// computer's browser uses it as its HTTP proxy. Each connection is carried by the owner's
// device through the Rakazo server; when no device is online it goes out directly instead.
//
// It runs in a stock Node image with no packages, so it uses only Node's built-ins. Keep the
// close codes and the ready message in step with packages/contracts/src/user-devices.ts.
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP } from "node:net";

export const RELAY_PORT = 3128;
const EXIT_PATH = "/api/devices/exit";
// Any other close before the ready message (4404 included: no device carries it) goes direct.
const UNREACHABLE = 4502;
const READY = "ok";
/** After the server says no device is online, connections go out directly for this long. */
const DIRECT_FOR_MS = 15_000;
const OPEN_TIMEOUT_MS = 15_000;
const MAX_HEAD_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HOP_HEADERS = /^(proxy-connection|proxy-authorization|connection|keep-alive):/i;

/**
 * Reads a proxy request head: CONNECT host:port, or an absolute http:// URL, which is rewritten
 * to the origin form a server expects and told to close after one response.
 */
export function parseRequestHead(head) {
  const [requestLine, ...lines] = head.split("\r\n");
  const match = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(requestLine ?? "");
  if (!match) return null;
  const [, method, target, version] = match;
  if (method === "CONNECT") {
    const address = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
    if (!address) return null;
    const port = Number(address[2]);
    if (port < 1 || port > 65535) return null;
    return { connect: true, host: address[1].replace(/^\[|\]$/g, ""), port };
  }
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !url.hostname) return null;
  const kept = lines.filter((line) => line && !HOP_HEADERS.test(line));
  return {
    connect: false,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 80),
    head: [
      `${method} ${url.pathname}${url.search} ${version}`,
      ...kept,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  };
}

/**
 * Opens host:port through the owner's device. Resolves "unavailable" when no device carries it
 * (go out directly), "unreachable" when the device could not reach it, or the open socket.
 */
export function openThroughDevice({ url, token, host, port, WebSocketImpl = WebSocket }) {
  return new Promise((resolve) => {
    const target = new URL(EXIT_PATH, url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.searchParams.set("host", host);
    target.searchParams.set("port", String(port));
    let settled = false;
    let socket;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket?.close();
      settle("unavailable");
    }, OPEN_TIMEOUT_MS);
    try {
      socket = new WebSocketImpl(target, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      settle("unavailable");
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (settled) return;
      if (event.data === READY) settle(socket);
      else {
        socket.close();
        settle("unavailable");
      }
    });
    socket.addEventListener("close", (event) =>
      settle(event.code === UNREACHABLE ? "unreachable" : "unavailable"),
    );
    socket.addEventListener("error", () => settle("unavailable"));
  });
}

function carry(client, socket, first) {
  if (first.length) socket.send(first);
  client.on("data", (chunk) => {
    socket.send(chunk);
    if (socket.bufferedAmount < HIGH_WATER_BYTES) return;
    client.pause();
    const wait = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount < HIGH_WATER_BYTES) {
        clearInterval(wait);
        client.resume();
      }
    }, 25);
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    client.write(Buffer.from(event.data));
    // The browser beside it reads quickly; one that stops reading is cut off, not buffered.
    if (client.writableLength > MAX_BUFFERED_BYTES) client.destroy();
  });
  socket.addEventListener("close", () => client.end());
  client.on("end", () => socket.close(1000));
  client.on("close", () => socket.close(1000));
  client.on("error", () => socket.close(1000));
}

const failed = (client) =>
  client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

/**
 * The server's address for one connection. An internal http:// address names the web server's
 * container, whose address can change and which answers to an address rather than that name, so
 * the name is looked up each time.
 */
export async function exitUrl(url, resolve = lookup) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || isIP(parsed.hostname)) return url;
  const { address, family } = await resolve(parsed.hostname);
  parsed.hostname = family === 6 ? `[${address}]` : address;
  return parsed.href;
}

export function startRelay({ url, token, port = RELAY_PORT, WebSocketImpl = WebSocket }) {
  let directUntil = 0;

  async function open(request) {
    if (Date.now() >= directUntil) {
      const server = await exitUrl(url).catch(() => url);
      const result = await openThroughDevice({ url: server, token, ...request, WebSocketImpl });
      if (result === "unreachable") return null;
      if (result !== "unavailable") return { device: result };
      directUntil = Date.now() + DIRECT_FOR_MS;
    }
    return new Promise((resolve) => {
      const direct = connect({ host: request.host, port: request.port });
      direct.once("connect", () => resolve({ direct }));
      direct.once("error", () => resolve(null));
    });
  }

  const server = createServer((client) => {
    let buffered = Buffer.alloc(0);
    client.on("error", () => client.destroy());
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const request = parseRequestHead(buffered.subarray(0, end).toString("latin1"));
      const rest = buffered.subarray(end + 4);
      if (!request) {
        client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      void open(request).then((opened) => {
        if (client.destroyed) {
          opened?.device?.close(1000);
          opened?.direct?.destroy();
          return;
        }
        if (!opened) return failed(client);
        const first = request.connect
          ? rest
          : Buffer.concat([Buffer.from(request.head, "latin1"), rest]);
        if (request.connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (opened.device) carry(client, opened.device, first);
        else {
          if (first.length) opened.direct.write(first);
          client.pipe(opened.direct).pipe(client);
          opened.direct.on("error", () => client.destroy());
        }
        client.resume();
      });
    };
    client.on("data", onData);
  });
  server.listen(port);
  return server;
}

if (process.env.RAKAZO_EXIT_URL && process.env.RAKAZO_EXIT_TOKEN) {
  startRelay({ url: process.env.RAKAZO_EXIT_URL, token: process.env.RAKAZO_EXIT_TOKEN });
}
