import type { UserDeviceList, UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";

export type UserDeviceRequest = (
  path: string,
  method: "GET" | "DELETE",
) => Promise<{
  ok: boolean;
  status: number;
  readBody: () => Promise<unknown>;
}>;

/** The whole list, with whether this server can route browsing through a device. */
export async function readUserDeviceListWith(
  request: UserDeviceRequest,
  failureMessage: string,
): Promise<UserDeviceList> {
  const response = await request(USER_DEVICE_PATH, "GET");
  // Servers without user devices have no such route.
  if (response.status === 404) return { devices: [], canRouteTraffic: false };
  if (!response.ok) throw new Error(failureMessage);
  try {
    return userDeviceListSchema.parse(await response.readBody());
  } catch {
    throw new Error(failureMessage);
  }
}

export async function listUserDevicesWith(
  request: UserDeviceRequest,
  failureMessage: string,
): Promise<UserDeviceSummary[]> {
  return (await readUserDeviceListWith(request, failureMessage)).devices;
}

export async function removeUserDeviceWith(
  request: UserDeviceRequest,
  deviceId: string,
  failureMessage: string,
): Promise<void> {
  const response = await request(`${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`, "DELETE");
  if (!response.ok && response.status !== 404) throw new Error(failureMessage);
}
