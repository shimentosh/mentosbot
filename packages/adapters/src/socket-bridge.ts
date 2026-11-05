import type { Socket } from "node:net";
import WebSocket from "ws";

/** Bytes a side may have queued before the side feeding it pauses. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** Codes a peer may send in a close frame; anything else (1005, 1006, 1015) becomes 1011. */
function sendableCloseCode(code: number) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

/**
 * Relays every message between two sockets, text and binary alike, and closes each with the
 * other's code. A side that runs ahead of the other's send buffer is paused until it drains.
 */
export function pipeWebSockets(a: WebSocket, b: WebSocket) {
  const forward = (from: WebSocket, to: WebSocket) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState !== WebSocket.OPEN) return;
      to.send(data, { binary: isBinary }, () => {
        if (from.isPaused && to.bufferedAmount < HIGH_WATER_BYTES) from.resume();
      });
      if (to.bufferedAmount >= HIGH_WATER_BYTES) from.pause();
    });
    from.on("close", (code, reason) => {
      if (to.readyState === WebSocket.OPEN) to.close(sendableCloseCode(code), reason);
      else to.terminate();
    });
    from.on("error", () => from.terminate());
  };
  forward(a, b);
  forward(b, a);
}

/**
 * Carries a TCP connection over a WebSocket as binary messages; text messages are control and
 * are left to the caller. Either side ending closes the other once its queued bytes are sent.
 */
export function bridgeSocket(ws: WebSocket, tcp: Socket) {
  ws.on("message", (data, isBinary) => {
    if (!isBinary || tcp.destroyed) return;
    if (!tcp.write(data as Buffer)) ws.pause();
  });
  tcp.on("drain", () => ws.resume());
  tcp.on("data", (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true }, () => {
      if (tcp.isPaused() && ws.bufferedAmount < HIGH_WATER_BYTES) tcp.resume();
    });
    if (ws.bufferedAmount >= HIGH_WATER_BYTES) tcp.pause();
  });
  tcp.on("end", () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
  tcp.on("error", () => ws.terminate());
  tcp.on("close", () => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  });
  ws.on("close", () => tcp.end());
  ws.on("error", () => tcp.destroy());
}
