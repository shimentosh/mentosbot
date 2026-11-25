import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_RETRY_AFTER_MS } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as setupStore from "../setup/setup-store.js";
import type { DeviceTokenCipher } from "./user-device.js";
import {
  createUserDeviceAccess,
  deletePairedDevice,
  readDeviceChoices,
  readPairedDevice,
  saveDeviceChoices,
  savePairedDevice,
} from "./user-device.js";

vi.mock("../setup/setup-store.js", async (actual) => {
  const store = await actual<typeof setupStore>();
  return { ...store, writePrivateFile: vi.fn(store.writePrivateFile) };
});

const origin = "https://rakazo.example.com";
const other = "https://other.example.com";

// Reversible stand-in for OS encryption that still keeps the plaintext off disk.
const cipher: DeviceTokenCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value.split("").reverse().join("")),
  decrypt: async (value) => value.toString().split("").reverse().join(""),
};

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-device-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(userData, { recursive: true, force: true, maxRetries: 5 });
});

describe("device token storage", () => {
  it("keeps one encrypted, owner-only token per server origin", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "secret-token", deviceId: "d1", userId: "user-1" },
      cipher,
    );
    await savePairedDevice(
      userData,
      other,
      { token: "other-token", deviceId: null, userId: null },
      cipher,
    );
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "secret-token",
      deviceId: "d1",
      userId: "user-1",
    });
    expect((await readPairedDevice(userData, other, cipher))?.token).toBe("other-token");
    const dir = path.join(userData, "devices");
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      expect(await readFile(file, "utf8")).not.toContain("secret-token");
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
    }
    await deletePairedDevice(userData, origin);
    expect(await readPairedDevice(userData, origin, cipher)).toBeNull();
    expect((await readPairedDevice(userData, other, cipher))?.token).toBe("other-token");
  });

  it("refuses to store a token without secure storage and ignores undecryptable ones", async () => {
    const device = { token: "t", deviceId: null, userId: null };
    await expect(
      savePairedDevice(userData, origin, device, { ...cipher, available: async () => false }),
    ).rejects.toThrow();
    expect(await readPairedDevice(userData, origin, cipher)).toBeNull();
    await savePairedDevice(userData, origin, device, cipher);
    expect(
      await readPairedDevice(userData, origin, {
        ...cipher,
        decrypt: async () => {
          throw new Error("locked");
        },
      }),
    ).toBeNull();
  });

  it("keeps each account's choices per server origin, the latest first", async () => {
    expect(await readDeviceChoices(userData, origin)).toEqual([]);
    await saveDeviceChoices(userData, origin, [
      { consent: "allowed", userId: "user-1", routeTraffic: false },
      { consent: "declined", userId: "user-2" },
    ]);
    await saveDeviceChoices(userData, other, [{ consent: "declined", userId: null }]);
    expect(await readDeviceChoices(userData, origin)).toEqual([
      { consent: "allowed", userId: "user-1", routeTraffic: false },
      { consent: "declined", userId: "user-2" },
    ]);
    expect(await readDeviceChoices(userData, other)).toEqual([
      { consent: "declined", userId: null },
    ]);
  });

  it("reads the single answer older versions saved, asking again for a decline saved before accounts were", async () => {
    const dir = path.join(userData, "devices");
    await saveDeviceChoices(userData, origin, []);
    await saveDeviceChoices(userData, other, []);
    const legacy: Record<string, object> = {
      [origin]: { origin, consent: "allowed", userId: "user-1" },
      // The server's sign-out wrote these too, so the answer may not be the person's.
      [other]: { origin: other, consent: "declined" },
    };
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      const saved = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify(legacy[saved.origin]));
    }
    expect(await readDeviceChoices(userData, origin)).toEqual([
      { consent: "allowed", userId: "user-1" },
    ]);
    expect(await readDeviceChoices(userData, other)).toEqual([]);
  });
});

describe("remote computer access", () => {
  const accesses: ReturnType<typeof createUserDeviceAccess>[] = [];
  // select() pairs in the background; its token write must land before the directory is removed.
  afterEach(async () => {
    await Promise.all(accesses.splice(0).map((access) => access.pair()));
  });

  function setup(overrides: Partial<Parameters<typeof createUserDeviceAccess>[0]> = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    const clients: {
      origin: string;
      token: string;
      closed: boolean;
      cancelled: number;
      active: number;
      revoke: (reason?: "session-ended") => void;
      authorize: () => Promise<boolean>;
    }[] = [];
    const access = createUserDeviceAccess({
      userDataDir: userData,
      cipher,
      device: async () => ({ name: "Test Mac", platform: "darwin" }),
      confirm: async () => true,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith("/api/devices/pair"))
          return Response.json({ deviceId: "device-1", token: "device-token" });
        return new Response(null, { status: 204 });
      },
      connect: (serverOrigin, token, events) => {
        const client = {
          origin: serverOrigin,
          token,
          closed: false,
          cancelled: 0,
          active: 0,
          revoke: events.onRevoked,
          authorize: events.authorize,
        };
        clients.push(client);
        return {
          close: () => {
            client.closed = true;
          },
          cancelAll: () => {
            client.cancelled += 1;
          },
          active: () => {
            client.active += 1;
          },
        };
      },
      ...overrides,
    });
    accesses.push(access);
    return { access, requests, clients };
  }

  it("does not pair or grant computer access to a cleartext remote server", async () => {
    const fetch = vi.fn();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    const remote = "http://192.168.1.20:3100";
    await access.select(remote);
    await access.pair();
    await access.setAllowed(remote, true);
    expect(access.state(remote)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(clients).toHaveLength(0);
  });

  it("pairs with the window session on its own and connects without granting anything", async () => {
    const confirm = vi.fn(async () => true);
    const { access, requests, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${origin}/api/devices/pair`);
    expect(requests[0]!.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      name: "Test Mac",
      platform: "darwin",
      pairingKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(clients).toMatchObject([{ origin, token: "device-token", closed: false }]);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: false });
    expect(access.state(other)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "device-token",
      deviceId: "device-1",
      userId: null,
    });
  });

  it("routes traffic with the device token alone, pairing first even after host access was declined", async () => {
    await saveDeviceChoices(userData, origin, [{ consent: "declined", userId: null }]);
    const confirm = vi.fn(async () => true);
    const { access, requests, clients } = setup({ confirm });
    await access.select(origin);
    expect(clients).toHaveLength(0);

    await access.setRouteTraffic(origin, true);
    expect(clients).toMatchObject([{ origin, token: "device-token" }]);
    const route = requests.at(-1)!;
    expect(route.url).toBe(`${origin}/api/devices/self/route-traffic`);
    expect(route.init).toMatchObject({
      method: "PUT",
      credentials: "omit",
      headers: { authorization: "Bearer device-token" },
    });
    expect(JSON.parse(String(route.init.body))).toEqual({ routeTraffic: true });
    // Routing grants no host access: requests still need this computer's own consent.
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();

    await access.setRouteTraffic(other, true);
    expect(requests.at(-1)).toBe(route);
  });

  it("reports a refused routing change", async () => {
    const { access } = setup({
      fetch: async (url) =>
        url.endsWith("/api/devices/pair")
          ? Response.json({ deviceId: "device-1", token: "device-token" })
          : new Response(null, { status: 401 }),
    });
    await access.select(origin);
    await access.pair();
    await expect(access.setRouteTraffic(origin, false)).rejects.toThrow("Could not change routing");
  });

  it.each(["settings", "request"] as const)(
    "saves consent before permission setup from %s, so a restart keeps it",
    async (source) => {
      const prepareAccess = vi.fn(async () => {
        expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "allowed" }]);
        expect(access.state(origin)?.allowed).toBe(true);
      });
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      if (source === "settings") await access.setAllowed(origin, true);
      else expect(await clients[0]!.authorize()).toBe(true);
      expect(prepareAccess).toHaveBeenCalledOnce();
      await prepareAccess.mock.results[0]!.value;
    },
  );

  it.each(["settings", "request"] as const)(
    "does not offer setup or authorize access when saving consent from %s fails",
    async (source) => {
      const prepareAccess = vi.fn(async () => undefined);
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
      vi.mocked(setupStore.writePrivateFile).mockRejectedValueOnce(failure);
      const request =
        source === "settings" ? access.setAllowed(origin, true) : clients[0]!.authorize();
      await expect(request).rejects.toBe(failure);
      expect(prepareAccess).not.toHaveBeenCalled();
      expect(access.state(origin)?.allowed).toBe(false);
      expect(await readDeviceChoices(userData, origin)).toEqual([]);
    },
  );

  it("refuses requests sharing an approval when its consent write fails", async () => {
    const answer = deferred<boolean>();
    const written = deferred<void>();
    const confirm = vi.fn(() => answer.promise);
    const prepareAccess = vi.fn(async () => undefined);
    const { access, clients } = setup({ confirm, prepareAccess });
    await access.select(origin);
    await access.pair();
    vi.mocked(setupStore.writePrivateFile)
      .mockClear()
      .mockImplementationOnce(() => written.promise);
    const first = clients[0]!.authorize();
    const second = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    answer.resolve(true);
    await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const refused = expect(first).rejects.toBe(failure);
    written.reject(failure);
    await refused;
    expect(await second).toBe(false);
    expect(prepareAccess).not.toHaveBeenCalled();
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it.each(["disable", "revoke"] as const)(
    "does not start setup after %s while saving allowed consent",
    async (action) => {
      const saved = deferred<void>();
      const prepareAccess = vi.fn(async () => undefined);
      const { access, clients } = setup({ prepareAccess });
      await access.select(origin);
      await access.pair();
      vi.mocked(setupStore.writePrivateFile)
        .mockClear()
        .mockImplementationOnce(() => saved.promise);
      const turningOn = access.setAllowed(origin, true);
      await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
      const turningOff =
        action === "disable" ? access.setAllowed(origin, false) : clients[0]!.revoke();
      saved.resolve();
      await turningOn;
      await turningOff;
      expect(prepareAccess).not.toHaveBeenCalled();
      expect(access.state(origin)?.allowed).toBe(false);
      await vi.waitFor(async () =>
        expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "declined" }]),
      );
    },
  );

  it("runs commands while setup is open, and invalidates setup when access is revoked", async () => {
    const ready = deferred<void>();
    const prepareAccess = vi.fn((_valid: () => boolean) => ready.promise);
    const { access, clients } = setup({ prepareAccess });
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(true);
    expect(prepareAccess).toHaveBeenCalledOnce();
    const valid = prepareAccess.mock.calls[0]![0];
    expect(valid()).toBe(true);
    await access.setAllowed(origin, false);
    expect(valid()).toBe(false);
    ready.resolve();
    await prepareAccess.mock.results[0]!.value;
    expect(await clients[0]!.authorize()).toBe(false);
  });

  it("asks once on the first request, keeps the answer, and lets waiting requests share it", async () => {
    const answer = deferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const first = clients[0]!.authorize();
    const second = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("rakazo.example.com");
    answer.resolve(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)?.allowed).toBe(true);
    expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "allowed" }]);

    const relaunched = setup({ confirm });
    await relaunched.access.select(origin);
    expect(await relaunched.clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("refuses every request after Cancel without asking again, until turned back on", async () => {
    const confirm = vi.fn(async () => false);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(false);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "declined" }]);

    confirm.mockResolvedValue(true);
    await access.setAllowed(origin, true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await clients[0]!.authorize()).toBe(true);
    await access.setAllowed(origin, false);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: false });
  });

  it("stops running and waiting work, but keeps the connection, when turned off", async () => {
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: null }]);
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    await access.setAllowed(origin, false);
    expect(clients).toMatchObject([{ closed: false, cancelled: 1 }]);
    expect(await clients[0]!.authorize()).toBe(false);
  });

  it("refuses new commands immediately while saving a disabled choice", async () => {
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    await access.setAllowed(origin, true);
    const saved = deferred<void>();
    vi.mocked(setupStore.writePrivateFile)
      .mockClear()
      .mockImplementationOnce(() => saved.promise);
    const turningOff = access.setAllowed(origin, false);
    await vi.waitFor(() => expect(setupStore.writePrivateFile).toHaveBeenCalledOnce());
    expect(await clients[0]!.authorize()).toBe(false);
    saved.resolve();
    await turningOff;
  });

  it("stops work and stays off when saving the choice fails", async () => {
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: null }]);
    const { access, clients } = setup();
    await access.select(origin);
    await access.pair();
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    vi.mocked(setupStore.writePrivateFile).mockRejectedValueOnce(failure);
    await expect(access.setAllowed(origin, false)).rejects.toBe(failure);
    expect(clients).toMatchObject([{ cancelled: 1 }]);
    expect(await clients[0]!.authorize()).toBe(false);
    expect(await readDeviceChoices(userData, origin)).toEqual([]);

    await access.select(other);
    await access.select(origin);
    expect(await clients.at(-1)!.authorize()).toBe(false);
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it("ignores a prompt answered after access was turned off or revoked", async () => {
    let answer!: Deferred<boolean>;
    const confirm = vi.fn(() => {
      answer = deferred<boolean>();
      return answer.promise;
    });
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    await access.pair();
    const waiting = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await access.setAllowed(origin, false);
    answer.resolve(true);
    expect(await waiting).toBe(false);
    expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "declined" }]);

    const turningOn = access.setAllowed(origin, true);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    clients[0]!.revoke();
    answer.resolve(true);
    await turningOn;
    expect(await readDeviceChoices(userData, origin)).toEqual([]);
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    expect(requests.filter(({ url }) => url.endsWith("/pair"))).toHaveLength(1);
  });

  it("fails turning on and stays off when pairing fails", async () => {
    await saveDeviceChoices(userData, origin, [{ consent: "declined", userId: null }]);
    let status = 409;
    const fetch = vi.fn(async () =>
      status === 200
        ? Response.json({ deviceId: "device-1", token: "device-token" })
        : new Response(null, { status }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await expect(access.setAllowed(origin, true)).rejects.toThrow();
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    expect(await readDeviceChoices(userData, origin)).toEqual([]);
    status = 200;
    await access.setAllowed(origin, true);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients).toHaveLength(1);
  });

  it("keeps access off when it is turned off while pairing", async () => {
    await saveDeviceChoices(userData, origin, [{ consent: "declined", userId: null }]);
    let respond: () => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json({ deviceId: "device-1", token: "device-token" }));
        }),
    );
    const { access } = setup({ fetch, confirm: async () => true });
    await access.select(origin);
    const turningOn = access.setAllowed(origin, true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await access.setAllowed(origin, false);
    respond();
    await turningOn;
    expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "declined" }]);
    expect(access.state(origin)?.allowed).toBe(false);
  });

  it("ignores a page asking for a server it no longer shows", async () => {
    const confirm = vi.fn(async () => true);
    let respond = () => {};
    const started = deferred();
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json({ deviceId: "device-1", token: "device-token" }));
          started.resolve();
        }),
    );
    const { access, clients } = setup({ confirm, fetch });
    await access.select(origin);
    const pairing = access.pair();
    await started.promise;
    try {
      await access.setAllowed(other, true);
      expect(confirm).not.toHaveBeenCalled();
      expect(await readDeviceChoices(userData, other)).toEqual([]);
    } finally {
      respond();
      await pairing;
    }
    expect(clients).toHaveLength(1);
    expect(await readPairedDevice(userData, origin, cipher)).toEqual({
      token: "device-token",
      deviceId: "device-1",
      userId: null,
    });
  });

  it("retries a signed-out pairing on the next page load but not a refused one", async () => {
    let status = 401;
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/api/devices/pair") && status === 200
        ? Response.json({ deviceId: "device-1", token: "device-token" })
        : new Response(null, { status }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await access.pair();
    expect(clients).toEqual([]);
    status = 200;
    await access.pair();
    expect(clients).toHaveLength(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    const refused = setup({ fetch });
    for (const refusal of [400, 403, 404, 405, 409, 413, 415, 422, 426]) {
      status = refusal;
      const target = `https://refused-${refusal}.example.com`;
      await refused.access.select(target);
      await refused.access.pair();
      // Past any retry delay, so only a remembered refusal keeps the second load from asking.
      vi.setSystemTime(Date.now() + MAX_RETRY_AFTER_MS + 1);
      await refused.access.pair();
      expect(fetch.mock.calls.filter(([url]) => url.startsWith(target))).toHaveLength(1);
    }
  });

  it("retries a pairing the server could not answer on a later page load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const failure of [503, 502, 500, 429, 408, "network"] as const) {
      let failing = true;
      const fetch = vi.fn(async (url: string) => {
        if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
        if (failing && failure === "network") throw new Error("offline");
        return failing
          ? new Response(null, { status: failure as number })
          : Response.json({ deviceId: "device-1", token: "device-token" });
      });
      const { access, clients } = setup({ fetch });
      await access.select(`https://retry-${failure}.example.com`);
      await access.pair();
      await access.pair();
      expect(clients).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      failing = false;
      vi.advanceTimersByTime(5_000);
      await access.pair();
      expect(clients).toHaveLength(1);
    }
  });

  it("reuses a random request key after a lost pairing response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tokens: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      const { pairingKey } = JSON.parse(init!.body as string);
      tokens.push(pairingKey);
      if (tokens.length < 3) throw new Error("response lost");
      return Response.json({ deviceId: "device-1", token: "server-token" });
    });
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(clients).toHaveLength(1);
  });

  it("starts a fresh pairing after the server refuses recovery by another sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const keys: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      keys.push(JSON.parse(init!.body as string).pairingKey);
      if (keys.length === 1) throw new Error("response lost");
      if (keys.length === 2) return new Response(null, { status: 401 });
      return Response.json({ deviceId: "device-1", token: "server-token" });
    });
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    vi.advanceTimersByTime(5_000);
    await access.pair();
    await access.pair();
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(clients).toHaveLength(1);
  });

  it.each([429, 503])("honors Retry-After after %i without scheduling requests", async (status) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async () =>
      fetch.mock.calls.length === 1
        ? new Response(null, { status, headers: { "retry-after": "60" } })
        : Response.json({ deviceId: "device-1", token: "server-token" }),
    );
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    await access.pair();
    vi.advanceTimersByTime(59_999);
    await access.pair();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await access.pair();
    expect(clients).toHaveLength(1);
  });

  it("sends a fresh request when computer access is turned on during the retry delay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async (url: string) =>
      fetch.mock.calls.length === 1
        ? new Response(null, { status: 503, headers: { "retry-after": "60" } })
        : url.endsWith("/pair")
          ? Response.json({ deviceId: "device-1", token: "server-token" })
          : new Response(null, { status: 204 }),
    );
    const pairings = () => fetch.mock.calls.filter(([url]) => url.endsWith("/pair")).length;
    const { access, clients } = setup({ fetch });
    await access.select(other);
    await access.pair();
    expect(pairings()).toBe(1);
    await access.setAllowed(other, true);
    expect(pairings()).toBe(2);
    expect(clients).toHaveLength(1);
  });

  it("never pairs without secure storage", async () => {
    const { access, requests } = setup({ cipher: { ...cipher, available: async () => false } });
    await access.select(origin);
    await access.pair();
    expect(requests).toEqual([]);
  });

  it("reconnects on launch, disconnects when switching servers, and stops on close", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    await saveDeviceChoices(userData, other, [{ consent: "declined", userId: null }]);
    const { access, clients, requests } = setup();
    await access.select(origin);
    expect(clients).toMatchObject([{ origin, token: "saved-token", closed: false }]);
    await access.select(other);
    await access.pair();
    expect(clients[0]!.closed).toBe(true);
    expect(clients).toHaveLength(1);
    expect(requests.map((request) => request.url)).toEqual([`${origin}/api/devices/self/session`]);
    await access.select(origin);
    expect(clients).toHaveLength(2);
    access.close();
    expect(clients[1]!.closed).toBe(true);
  });

  it("reports use only on the connection of the server it shows", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    const { access, clients } = setup();
    access.active();
    await access.select(origin);
    access.active();
    expect(clients).toMatchObject([{ origin, active: 1 }]);
    access.close();
    access.active();
    expect(clients[0]!.active).toBe(1);
  });

  it("ties a saved pairing to the sign-in once, retrying until the server ties it", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    const statuses = [401, 500, 502];
    const release = deferred();
    const { access, requests } = setup({
      fetch: async (url, init) => {
        requests.push({ url, init });
        // The first request is still out when the window signs in.
        if (requests.length === 1) await release.promise;
        return new Response(null, { status: statuses.shift() ?? 204 });
      },
    });
    await access.select(origin);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      url: `${origin}/api/devices/self/session`,
      init: {
        method: "POST",
        credentials: "include",
        headers: { authorization: "Bearer saved-token" },
      },
    });
    await access.pair();
    release.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(2));

    await access.pair();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await access.pair();
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    // The fake fetch does no I/O, so every pending promise settles before setImmediate runs.
    await new Promise(setImmediate);
    await access.pair();
    await new Promise(setImmediate);
    expect(requests).toHaveLength(4);
  });

  it("forgets a revoked token and stays unpaired until turned back on", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: null },
      cipher,
    );
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: null }]);
    const confirm = vi.fn(async () => true);
    const { access, clients, requests } = setup({ confirm });
    await access.select(origin);
    clients[0]!.revoke();
    await vi.waitFor(async () =>
      expect(await readPairedDevice(userData, origin, cipher)).toBeNull(),
    );
    await vi.waitFor(async () =>
      expect(await readDeviceChoices(userData, origin)).toMatchObject([{ consent: "declined" }]),
    );
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    await access.pair();
    expect(requests.map((request) => request.url)).toEqual([
      `${origin}/api/devices/self/session`,
      // The allowed computer put its routing back on launch.
      `${origin}/api/devices/self/route-traffic`,
    ]);

    await access.setAllowed(origin, true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });
    expect(clients.at(-1)).toMatchObject({ token: "device-token", closed: false });
  });
  it("pairs afresh when turned on and the account no longer lists the saved computer", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: "alice" },
      cipher,
    );
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: "alice" }]);
    const { access, clients, requests } = setup({
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url === `${origin}/api/devices`) return Response.json({ devices: [] });
        if (url.endsWith("/api/devices/pair"))
          return Response.json({ deviceId: "device-2", token: "new-token", userId: "alice" });
        return new Response(null, { status: 204 });
      },
    });
    await access.select(origin);
    expect(access.state(origin)).toEqual({ deviceId: "d1", allowed: true });

    await access.setAllowed(origin, false);
    await access.setAllowed(origin, true);
    expect(clients[0]).toMatchObject({ token: "saved-token", closed: true });
    expect(clients.at(-1)).toMatchObject({ token: "new-token", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: true });
    expect(await readPairedDevice(userData, origin, cipher)).toMatchObject({ token: "new-token" });
    expect(requests.find(({ init }) => init.method === "DELETE")).toMatchObject({
      url: `${origin}/api/devices/self`,
      init: { headers: { authorization: "Bearer saved-token" } },
    });
  });

  it("keeps the saved computer when the account lists it or the list cannot be read", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: "alice" },
      cipher,
    );
    let list: Response = Response.json({ devices: [{ deviceId: "d1" }] });
    const { access, clients, requests } = setup({
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url === `${origin}/api/devices`) return list;
        return new Response(null, { status: 204 });
      },
    });
    await access.select(origin);
    await access.setRouteTraffic(origin, true);
    list = new Response(null, { status: 401 });
    await access.setAllowed(origin, true);
    expect(clients).toMatchObject([{ token: "saved-token", closed: false }]);
    expect(access.state(origin)).toEqual({ deviceId: "d1", allowed: true });
    expect(requests.some(({ url }) => url.endsWith("/pair"))).toBe(false);
  });

  /** A server that pairs whoever the window is signed in as. */
  function accountServer() {
    const server = { account: null as string | null, paired: 0 };
    const fetch = vi.fn(async (url: string) => {
      if (!url.endsWith("/api/devices/pair")) return new Response(null, { status: 204 });
      if (server.account === null) return new Response(null, { status: 401 });
      server.paired += 1;
      return Response.json({
        deviceId: `device-${server.paired}`,
        token: `token-${server.paired}`,
        userId: server.account,
      });
    });
    return { server, fetch };
  }

  it("keeps access for an account that signs out and back in, without asking again", async () => {
    const { server, fetch } = accountServer();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.pair();
    expect(await clients[0]!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);

    server.account = null;
    clients[0]!.revoke("session-ended");
    await vi.waitFor(async () =>
      expect(await readPairedDevice(userData, origin, cipher)).toBeNull(),
    );
    expect(access.state(origin)).toEqual({ deviceId: null, allowed: false });
    await access.pair();
    expect(clients).toHaveLength(1);

    server.account = "alice";
    await access.pair();
    expect(clients.at(-1)).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: true });
    expect(await clients.at(-1)!.authorize()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readDeviceChoices(userData, origin)).toEqual([
      {
        consent: "allowed",
        userId: "alice",
      },
    ]);
  });

  it("never hands one account's access to the next person who signs in", async () => {
    const { server, fetch } = accountServer();
    const confirm = vi.fn(async () => true);
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.setAllowed(origin, true);
    expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true });

    server.account = null;
    clients[0]!.revoke("session-ended");
    server.account = "bob";
    await access.pair();
    expect(clients.at(-1)).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });

    confirm.mockResolvedValueOnce(false);
    expect(await clients.at(-1)!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("ignores a prompt from a sign-in that ended before it was answered", async () => {
    const { server, fetch } = accountServer();
    let answer!: Deferred<boolean>;
    const confirm = vi.fn(() => {
      answer = deferred<boolean>();
      return answer.promise;
    });
    const { access, clients } = setup({ fetch, confirm });
    server.account = "alice";
    await access.select(origin);
    await access.pair();
    const waiting = clients[0]!.authorize();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    server.account = null;
    clients[0]!.revoke("session-ended");
    server.account = "bob";
    await access.pair();
    answer.resolve(true);
    expect(await waiting).toBe(false);
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });
    expect(await readDeviceChoices(userData, origin)).toEqual([]);
  });

  it("pairs the next account even when its page loaded before the old pairing ended", async () => {
    const { server, fetch } = accountServer();
    const { access, clients } = setup({ fetch });
    server.account = "alice";
    await access.select(origin);
    await access.pair();

    server.account = "bob";
    await access.pair();
    expect(clients).toHaveLength(1);
    clients[0]!.revoke("session-ended");
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[1]).toMatchObject({ token: "token-2", closed: false });
    expect(access.state(origin)).toEqual({ deviceId: "device-2", allowed: false });
  });

  it("does not let a saved answer for another account through after a relaunch", async () => {
    await savePairedDevice(
      userData,
      origin,
      { token: "saved-token", deviceId: "d1", userId: "bob" },
      cipher,
    );
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: "alice" }]);
    const confirm = vi.fn(async () => false);
    const { access, clients } = setup({ confirm });
    await access.select(origin);
    expect(access.state(origin)).toEqual({ deviceId: "d1", allowed: false });
    expect(await clients[0]!.authorize()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  /** A server that pairs whoever is signed in and ties only that account's token. */
  function switchingServer() {
    const server = { account: "alice", paired: 0, owners: new Map<string, string>() };
    const requests: { url: string; init: RequestInit }[] = [];
    const routed: { token: string; routeTraffic: boolean }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const token = String(new Headers(init.headers).get("authorization")).replace("Bearer ", "");
      if (url.endsWith("/api/devices/pair")) {
        server.paired += 1;
        server.owners.set(`token-${server.paired}`, server.account);
        return Response.json({
          deviceId: `device-${server.paired}`,
          token: `token-${server.paired}`,
          userId: server.account,
        });
      }
      if (url.endsWith("/api/devices/self/session"))
        return new Response(null, {
          status: server.owners.get(token) === server.account ? 204 : 403,
        });
      if (url.endsWith("/api/devices/self/route-traffic"))
        routed.push({ token, routeTraffic: JSON.parse(String(init.body)).routeTraffic });
      return new Response(null, { status: 204 });
    });
    return { server, fetch, requests, routed };
  }

  it("moves to the account signed in now when the saved pairing belongs to another", async () => {
    const { server, fetch, routed } = switchingServer();
    await savePairedDevice(
      userData,
      origin,
      { token: "old-token", deviceId: "d1", userId: "bob" },
      cipher,
    );
    server.owners.set("old-token", "bob");
    await saveDeviceChoices(userData, origin, [{ consent: "allowed", userId: "alice" }]);
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await vi.waitFor(() =>
      expect(access.state(origin)).toEqual({ deviceId: "device-1", allowed: true }),
    );
    expect(clients[0]).toMatchObject({ token: "old-token", closed: true });
    expect(clients.at(-1)).toMatchObject({ token: "token-1", closed: false });
    expect(fetch).toHaveBeenCalledWith(
      `${origin}/api/devices/self`,
      expect.objectContaining({ method: "DELETE" }),
    );
    // Alice allowed this computer before, so her new pairing routes without another click.
    await vi.waitFor(() => expect(routed).toContainEqual({ token: "token-1", routeTraffic: true }));
  });

  it("checks the account after a full page load, so a sign-in to another account moves the computer", async () => {
    const { server, fetch } = switchingServer();
    const { access, clients } = setup({ fetch });
    await access.select(origin);
    await access.pair();
    await vi.waitFor(() => expect(access.state(origin)).toMatchObject({ deviceId: "device-1" }));

    server.account = "bob";
    await access.pair();
    expect(access.state(origin)).toMatchObject({ deviceId: "device-1" });
    await access.pair(true);
    await vi.waitFor(() => expect(access.state(origin)).toMatchObject({ deviceId: "device-2" }));
    expect(clients.at(-1)).toMatchObject({ token: "token-2", closed: false });
  });

  it("keeps each account's choices across switches and puts routing back on each new pairing", async () => {
    const { server, fetch, routed } = switchingServer();
    const confirm = vi.fn(async () => true);
    const { access } = setup({ fetch, confirm });
    await access.select(origin);
    await access.setAllowed(origin, true);
    // Allowing the computer turns routing on as well.
    expect(routed).toEqual([{ token: "token-1", routeTraffic: true }]);

    server.account = "bob";
    await access.pair(true);
    await vi.waitFor(() => expect(access.state(origin)).toMatchObject({ deviceId: "device-2" }));
    expect(access.state(origin)).toMatchObject({ allowed: false });
    await access.setRouteTraffic(origin, false);

    server.account = "alice";
    await access.pair(true);
    await vi.waitFor(() =>
      expect(access.state(origin)).toEqual({ deviceId: "device-3", allowed: true }),
    );
    await vi.waitFor(() => expect(routed.at(-1)).toEqual({ token: "token-3", routeTraffic: true }));

    server.account = "bob";
    await access.pair(true);
    await vi.waitFor(() => expect(access.state(origin)).toMatchObject({ deviceId: "device-4" }));
    // Bob turned routing off, so his next pairing leaves it off.
    expect(routed.some(({ token }) => token === "token-4")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readDeviceChoices(userData, origin)).toEqual([
      { userId: "bob", routeTraffic: false },
      { userId: "alice", consent: "allowed" },
    ]);
  });
});
