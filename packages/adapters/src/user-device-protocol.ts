import { z } from "zod";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";

export const userDeviceRevokeReason = z.enum(["session-ended"]);
/** Carries the revoke reason on a refused connection, which has no message to put it in. */
export const USER_DEVICE_REVOKED_HEADER = "x-rakazo-device-revoked";
export type UserDeviceRevokeReason = z.infer<typeof userDeviceRevokeReason>;

/**
 * Carry one of the owner's computer connections: dial the server back with the ticket, then
 * reach host:port. Sent only to a device that chose to route traffic, and needs no reply.
 */
export const userDeviceNotice = z.object({
  type: z.literal("tunnel"),
  ticket: z.string().min(1).max(1024),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
});
export type UserDeviceNotice = z.infer<typeof userDeviceNotice>;

export const userDeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  userDeviceNotice,
  // "session-ended": the sign-in that paired it ended, so the next sign-in pairs again.
  z.object({ type: z.literal("revoked"), reason: userDeviceRevokeReason.optional() }),
]);
export type UserDeviceServerMessage = z.infer<typeof userDeviceServerMessage>;

/** One HostComputerFrame per message, tagged with the request id. */
export const userDeviceClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
]);
export type UserDeviceClientMessage = z.infer<typeof userDeviceClientMessage>;

export interface UserDevice {
  deviceId: string;
  name: string;
  platform: string;
}

/** How runs reach the requesting user's connected device, from any API or worker process. */
export interface UserDeviceGateway {
  /** The user's most recently connected device, or that one device when `deviceId` is given. */
  connected(userId: string, deviceId?: string): Promise<UserDevice | null>;
  /** When the oldest device still paired was paired, connected or not; null when none is. */
  pairedSince(userId: string): Promise<Date | null>;
  /**
   * Streams HostComputerFrame values for one request. Throws when the device is offline,
   * revoked, or disconnects mid-request; a command is never retried after a lost response.
   * Pass `deviceId` to keep every request of one operation on the same computer.
   */
  request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T>;
}
