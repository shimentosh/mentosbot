import { EventEmitter } from "node:events";
import type { AddressInfo, Server, Socket } from "node:net";
import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The relay is plain JavaScript so a stock Node image runs it as given.
import { parseRequestHead, startRelay } from "./device-exit-relay.mjs";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("proxy requests", () => {
  it("reads CONNECT targets", () => {
    expect(parseRequestHead("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443")).toEqual({
      connect: true,
      host: "example.com",
      port: 443,
    });
    expect(parseRequestHead("CONNECT [2001:db8::1]:443 HTTP/1.1")).toMatchObject({
      host: "2001:db8::1",
    });
    expect(parseRequestHead("CONNECT example.com:0 HTTP/1.1")).toBeNull();
    expect(parseRequestHead("CONNECT example.com HTTP/1.1")).toBeNull();
  });

  it("rewrites a plain HTTP request for the origin, without proxy headers", () => {
    const request = parseRequestHead(
      "GET http://example.com:8080/a?b=1 HTTP/1.1\r\nHost: example.com:8080\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: x\r\nAccept: */*",
    );
    expect(request).toEqual({
      connect: false,
      host: "example.com",
      port: 8080,
      head: "GET /a?b=1 HTTP/1.1\r\nHost: example.com:8080\r\nAccept: */*\r\nConnection: close\r\n\r\n",
    });
    expect(parseRequestHead("GET https://example.com/ HTTP/1.1")).toBeNull();
    expect(parseRequestHead("GET /relative HTTP/1.1")).toBeNull();
  });
});

/** Plays the server's side of one relay socket. */
type Script = "ready" | "unavailable" | "unreachable";

function fakeWebSocket(script: () => Script, opened: string[]) {
  return class extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = "blob";
    constructor(url: URL, init: { headers: Record<string, string> }) {
      super();
      opened.push(`${url.pathname}${url.search} ${init.headers.authorization}`);
      const step = script();
      queueMicrotask(() => {
        if (step === "ready") this.emit("message", { data: "ok" });
        else this.emit("close", { code: step === "unreachable" ? 4502 : 4404 });
      });
    }
    addEventListener(event: string, listener: (value: unknown) => void) {
      this.on(event, listener);
    }
    // The device side echoes what it is sent.
    send(data: Buffer) {
      const copy = Uint8Array.from(data).buffer;
      queueMicrotask(() => this.emit("message", { data: copy }));
    }
    close() {
      this.readyState = 3;
    }
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

async function relay(script: () => Script) {
  const opened: string[] = [];
  const echoPort = await listen(createServer((socket) => socket.pipe(socket)));
  const server = startRelay({
    url: "https://app.example.com",
    token: "home.mac",
    port: 0,
    WebSocketImpl: fakeWebSocket(script, opened),
  }) as Server;
  await new Promise((resolve) => server.once("listening", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as AddressInfo).port;
  const request = (head: string) =>
    new Promise<{ socket: Socket; reply: string }>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      closers.push(() => socket.destroy());
      socket.once("connect", () => socket.write(`${head}\r\n\r\n`));
      socket.once("data", (data) => resolve({ socket, reply: String(data) }));
    });
  return { request, opened, echoPort };
}

function exchange(socket: Socket, text: string) {
  return new Promise<string>((resolve) => {
    socket.once("data", (data) => resolve(String(data)));
    socket.write(text);
  });
}

describe("the relay beside a computer", () => {
  it("carries a connection through the owner's device", async () => {
    const { request, opened } = await relay(() => "ready");
    const { socket, reply } = await request("CONNECT example.com:443 HTTP/1.1");
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(opened).toEqual(["/api/devices/exit?host=example.com&port=443 Bearer home.mac"]);
    expect(await exchange(socket, "through home")).toBe("through home");
  });

  it("goes out directly when no device carries it, and keeps doing so for a while", async () => {
    const { request, opened, echoPort } = await relay(() => "unavailable");
    const first = await request(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1`);
    expect(first.reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(await exchange(first.socket, "direct")).toBe("direct");
    await request(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1`);
    expect(opened).toHaveLength(1);
  });

  it("fails the request when the device could not reach the destination", async () => {
    const { request } = await relay(() => "unreachable");
    expect((await request("CONNECT example.com:443 HTTP/1.1")).reply).toContain("502 Bad Gateway");
  });

  it("refuses requests it cannot read", async () => {
    const { request, opened } = await relay(() => "ready");
    expect((await request("GET /relative HTTP/1.1")).reply).toContain("400 Bad Request");
    expect(opened).toEqual([]);
  });
});
