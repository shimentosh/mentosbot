import { z } from "zod";

/** Owner-session revoke: DELETE `${USER_DEVICE_PATH}/:deviceId`. Device-token self revoke: DELETE `${USER_DEVICE_PATH}/self`. */
export const USER_DEVICE_PATH = "/api/devices";
export const USER_DEVICE_PAIR_PATH = `${USER_DEVICE_PATH}/pair`;
export const USER_DEVICE_CONNECT_PATH = `${USER_DEVICE_PATH}/connect`;
/** POST with the device token and the sign-in cookie: ties a pairing that predates session tracking to that sign-in. */
export const USER_DEVICE_SESSION_PATH = `${USER_DEVICE_PATH}/self/session`;

export const userDevicePairRequest = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type UserDevicePairRequest = z.infer<typeof userDevicePairRequest>;

export interface UserDevicePairResponse {
  deviceId: string;
  /** The account it was paired for. This computer's consent belongs to that account. */
  userId: string;
  /** Shown once. The server keeps only its hash. */
  token: string;
}

export const userDeviceListSchema = z.object({
  devices: z.array(
    z.object({
      deviceId: z.string(),
      name: z.string(),
      connected: z.boolean(),
      /** Computers' browsers reach the internet through this device while it is connected. */
      routeTraffic: z.boolean(),
    }),
  ),
  /** Whether this server's computers can send their browser traffic out through a device. */
  canRouteTraffic: z.boolean(),
});
export type UserDeviceList = z.infer<typeof userDeviceListSchema>;
export type UserDeviceSummary = UserDeviceList["devices"][number];

/** PUT with the device token only: a web session cannot send a computer's traffic through a device. */
export const USER_DEVICE_ROUTE_TRAFFIC_PATH = `${USER_DEVICE_PATH}/self/route-traffic`;
export const userDeviceRouteTrafficRequest = z.object({ routeTraffic: z.boolean() });

/** A computer's network relay opens one socket here per connection its browser makes. */
export const USER_DEVICE_EXIT_PATH = `${USER_DEVICE_PATH}/exit`;
/** The device opens one socket here per connection it carries, presenting the tunnel's ticket. */
export const USER_DEVICE_TUNNEL_PATH = `${USER_DEVICE_PATH}/tunnel`;
export const USER_DEVICE_TUNNEL_TICKET_HEADER = "x-rakazo-tunnel";
/**
 * Close codes the relay reads before any byte flows: no device carries this connection (go out
 * directly), or the device could not reach the destination.
 */
export const USER_DEVICE_EXIT_UNAVAILABLE = 4404;
export const USER_DEVICE_EXIT_UNREACHABLE = 4502;
/** The device's first text message once it reached the destination; bytes follow as binary. */
export const USER_DEVICE_EXIT_READY = "ok";
