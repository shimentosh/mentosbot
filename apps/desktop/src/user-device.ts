import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { UserDeviceClientOptions } from "@rakazo/adapters/user-device-client";
import type {
  RakazoDesktopDevice,
  UserDevicePairRequest,
  UserDevicePairResponse,
} from "@rakazo/contracts";
import {
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  USER_DEVICE_ROUTE_TRAFFIC_PATH,
  USER_DEVICE_SESSION_PATH,
} from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface DeviceTokenCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

const MAX_DEVICE_FILE_BYTES = 8 * 1024;
const MAX_TOKEN_LENGTH = 1024;

export interface PairedDevice {
  token: string;
  deviceId: string | null;
  /** The account it was paired for; null when paired before the server reported it. */
  userId: string | null;
}

/** Only the native prompt sets "allowed". */
export type DeviceConsent = "allowed" | "declined";

/** One account's choices on this computer; "allowed" holds only for that account. */
export interface SavedChoice {
  userId: string | null;
  consent?: DeviceConsent;
  /** Routing the person set; unset routes while the computer is allowed. */
  routeTraffic?: boolean;
}

/** The people who sign in here are few; the oldest choices drop off past this. */
const MAX_SAVED_ACCOUNTS = 8;

const optionalString = (value: unknown) => (typeof value === "string" ? value : null);

function deviceFile(userDataDir: string, origin: string, suffix = "") {
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return path.join(userDataDir, "devices", `${key}${suffix}.json`);
}

export async function readPairedDevice(
  userDataDir: string,
  origin: string,
  cipher: DeviceTokenCipher,
): Promise<PairedDevice | null> {
  const raw = await readPrivateFile(deviceFile(userDataDir, origin), MAX_DEVICE_FILE_BYTES);
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved?.origin !== origin || typeof saved.token !== "string") return null;
    const token = await cipher.decrypt(Buffer.from(saved.token, "base64"));
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    return {
      token,
      deviceId: optionalString(saved.deviceId),
      userId: optionalString(saved.userId),
    };
  } catch {
    return null;
  }
}

export async function savePairedDevice(
  userDataDir: string,
  origin: string,
  device: PairedDevice,
  cipher: DeviceTokenCipher,
): Promise<void> {
  if (!(await cipher.available())) throw new Error("Secure storage is unavailable");
  const file = deviceFile(userDataDir, origin);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = (await cipher.encrypt(device.token)).toString("base64");
  await writePrivateFile(
    file,
    JSON.stringify({ origin, token, deviceId: device.deviceId, userId: device.userId }),
  );
}

export async function deletePairedDevice(userDataDir: string, origin: string): Promise<void> {
  await rm(deviceFile(userDataDir, origin), { force: true });
}

/** Every account's choices for a server, the most recently changed first. */
export async function readDeviceChoices(
  userDataDir: string,
  origin: string,
): Promise<SavedChoice[]> {
  const raw = await readPrivateFile(
    deviceFile(userDataDir, origin, ".consent"),
    MAX_DEVICE_FILE_BYTES,
  );
  try {
    const saved = raw === null ? null : JSON.parse(raw);
    if (saved?.origin !== origin) return [];
    if (!Array.isArray(saved.accounts)) {
      // Versions before accounts were saved also wrote "declined" when the server ended a
      // pairing, so that answer may not be the person's: ask again.
      if (saved.consent === "declined" && !("userId" in saved)) return [];
      const choice = savedChoice(saved);
      return choice?.consent ? [choice] : [];
    }
    return saved.accounts
      .map(savedChoice)
      .filter((choice: SavedChoice | null): choice is SavedChoice => choice !== null)
      .slice(0, MAX_SAVED_ACCOUNTS);
  } catch {
    return [];
  }
}

function savedChoice(value: unknown): SavedChoice | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const choice: SavedChoice = { userId: optionalString(entry.userId) };
  if (entry.consent === "allowed" || entry.consent === "declined") choice.consent = entry.consent;
  if (typeof entry.routeTraffic === "boolean") choice.routeTraffic = entry.routeTraffic;
  return choice.consent || choice.routeTraffic !== undefined ? choice : null;
}

export async function saveDeviceChoices(
  userDataDir: string,
  origin: string,
  accounts: SavedChoice[],
): Promise<void> {
  const file = deviceFile(userDataDir, origin, ".consent");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateFile(
    file,
    JSON.stringify({ origin, accounts: accounts.slice(0, MAX_SAVED_ACCOUNTS) }),
  );
}

export async function deviceName(platform = process.platform): Promise<string> {
  const fallback = hostname().replace(/\.local$/, "") || "Computer";
  if (platform !== "darwin") return fallback.slice(0, 128);
  const friendly = await new Promise<string>((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }, (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    );
  });
  return (friendly || fallback).slice(0, 128);
}

/**
 * Connects this computer to the remote server the app shows. Pairing and connecting grant
 * nothing: every request waits for this computer's consent for that server, which only the
 * native prompt gives. The token and the consent stay in the main process and app-private storage.
 */
export function createUserDeviceAccess(deps: {
  userDataDir: string;
  cipher: DeviceTokenCipher;
  device: () => Promise<UserDevicePairRequest>;
  /** The native consent prompt. Resolves true only when the person clicks Allow. */
  confirm: (host: string) => Promise<boolean>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  connect: (
    origin: string,
    token: string,
    events: {
      onRevoked: UserDeviceClientOptions["onRevoked"];
      authorize: () => Promise<boolean>;
    },
  ) => { close(): void; cancelAll(): void };
}) {
  let current: string | null = null;
  let generation = 0;
  let client: { origin: string; close(): void; cancelAll(): void } | undefined;
  const paired = new Map<string, Omit<PairedDevice, "token">>();
  /** The token of the connection started for each origin, which only this process holds. */
  const tokens = new Map<string, string>();
  /** Each account's choices per origin, the most recently changed first. */
  const choices = new Map<string, SavedChoice[]>();
  /** Bumped on every consent change, so a prompt answered after one is ignored. */
  const changes = new Map<string, number>();
  const consentSaves = new Map<string, Promise<void>>();
  const unavailable = new Set<string>();
  const prompts = new Map<string, Promise<boolean>>();
  const pairings = new Map<string, Promise<void>>();
  /** Saved tokens not yet tied to a sign-in this launch; pairings from before that was recorded. */
  const untied = new Map<string, string>();
  const tying = new Map<string, { again: boolean }>();
  /** A revoked token's file deletion, which a new pairing's save must follow. */
  const removals = new Map<string, Promise<void>>();

  function disconnect() {
    client?.close();
    client = undefined;
  }

  function start(origin: string, token: string) {
    disconnect();
    tokens.set(origin, token);
    const active = {
      origin,
      close: () => connection.close(),
      cancelAll: () => connection.cancelAll(),
    };
    const connection = deps.connect(origin, token, {
      onRevoked: (reason) => {
        if (client === active) client = undefined;
        const userId = paired.get(origin)?.userId ?? null;
        paired.delete(origin);
        tokens.delete(origin);
        untied.delete(origin);
        removals.set(
          origin,
          deletePairedDevice(deps.userDataDir, origin).catch(() => undefined),
        );
        // Signing out ends the pairing but keeps the answer for that account's next sign-in;
        // a prompt still open belongs to the ended sign-in. Removed or rejected otherwise:
        // stay unpaired until turned back on.
        if (reason !== "session-ended") {
          void decide(origin, "declined", userId).catch(() => undefined);
          return;
        }
        changes.set(origin, (changes.get(origin) ?? 0) + 1);
        // Whoever signed in next may have loaded the page before this arrived.
        if (current === origin) void pair();
      },
      authorize: () => authorize(origin),
    });
    client = active;
  }

  /** The paired account's choices; none while unpaired. */
  function choiceFor(origin: string) {
    const device = paired.get(origin);
    if (!device) return undefined;
    return choices.get(origin)?.find((choice) => choice.userId === device.userId);
  }

  function isAllowed(origin: string) {
    return choiceFor(origin)?.consent === "allowed";
  }

  /** Records one account's change first in line and saves every account's choices. */
  function remember(origin: string, userId: string | null, change: Omit<SavedChoice, "userId">) {
    const list = choices.get(origin) ?? [];
    const previous = list.find((choice) => choice.userId === userId);
    const next = [
      { ...previous, ...change, userId },
      ...list.filter((choice) => choice !== previous),
    ].slice(0, MAX_SAVED_ACCOUNTS);
    choices.set(origin, next);
    const save = (consentSaves.get(origin) ?? Promise.resolve()).then(() =>
      saveDeviceChoices(deps.userDataDir, origin, next).catch(async (error) => {
        // An earlier "allowed" left on disk would be honoured on the next launch.
        if (change.consent === "declined")
          await rm(deviceFile(deps.userDataDir, origin, ".consent"), { force: true }).catch(
            () => undefined,
          );
        throw error;
      }),
    );
    consentSaves.set(
      origin,
      save.catch(() => undefined),
    );
    return save;
  }

  async function decide(
    origin: string,
    choice: DeviceConsent,
    userId = paired.get(origin)?.userId ?? null,
  ) {
    changes.set(origin, (changes.get(origin) ?? 0) + 1);
    await remember(origin, userId, { consent: choice });
  }

  async function putRouteTraffic(origin: string, routeTraffic: boolean) {
    const token = tokens.get(origin);
    if (!token) return false;
    const response = await deps.fetch(new URL(USER_DEVICE_ROUTE_TRAFFIC_PATH, origin).href, {
      method: "PUT",
      credentials: "omit",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ routeTraffic }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error("Could not change routing");
    return true;
  }

  /**
   * A new pairing starts with routing off on the server, so put back what this account chose.
   * Unset, an allowed computer routes: allowing it once turns both on.
   */
  async function restoreRouting(origin: string) {
    const choice = choiceFor(origin);
    if (!(choice?.routeTraffic ?? choice?.consent === "allowed")) return;
    await putRouteTraffic(origin, true).catch(() => undefined);
  }

  function ask(origin: string) {
    let prompt = prompts.get(origin);
    if (!prompt) {
      prompt = deps
        .confirm(new URL(origin).host)
        .catch(() => false)
        .finally(() => prompts.delete(origin));
      prompts.set(origin, prompt);
    }
    return prompt;
  }

  async function authorize(origin: string) {
    if (choiceFor(origin)?.consent === "declined") return false;
    if (isAllowed(origin)) return true;
    const seen = changes.get(origin);
    const answer = await ask(origin);
    // Turned off, revoked, or already answered while the prompt was open.
    if (changes.get(origin) !== seen) return isAllowed(origin);
    await decide(origin, answer ? "allowed" : "declined").catch(() => undefined);
    if (answer) void restoreRouting(origin);
    return answer;
  }

  /** `recheck` after a full page load: whoever signed in may be another account. */
  function pair(recheck = false) {
    const origin = current;
    if (origin === null) return Promise.resolve();
    const token = tokens.get(origin);
    if (recheck && token && !untied.has(origin)) untied.set(origin, token);
    void tieToSignIn(origin);
    if (choices.get(origin)?.[0]?.consent === "declined") return Promise.resolve();
    return pairOnce(origin);
  }

  /**
   * Retries on each sign-in until the server ties it; already tied, the server leaves it alone.
   * A sign-in during a request asks again once that request ends.
   */
  async function tieToSignIn(origin: string) {
    const running = tying.get(origin);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    tying.set(origin, state);
    try {
      for (;;) {
        const token = untied.get(origin);
        if (!token) return;
        state.again = false;
        const tie = await requestTie(origin, token);
        if (tie !== "retry") {
          if (untied.get(origin) === token) untied.delete(origin);
          // Paired for another account than the one signed in: this computer moves to it.
          if (tie === "other-account" && tokens.get(origin) === token) {
            await dropPairing(origin);
            if (current === origin) await pair();
          }
          return;
        }
        if (!state.again) return;
      }
    } finally {
      tying.delete(origin);
    }
  }

  async function requestTie(
    origin: string,
    token: string,
  ): Promise<"tied" | "other-account" | "retry"> {
    try {
      const response = await deps.fetch(new URL(USER_DEVICE_SESSION_PATH, origin).href, {
        method: "POST",
        credentials: "include",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.status === 204) return "tied";
      return response.status === 403 ? "other-account" : "retry";
    } catch {
      return "retry";
    }
  }

  function pairOnce(origin: string) {
    if (paired.has(origin) || unavailable.has(origin)) return Promise.resolve();
    let pairing = pairings.get(origin);
    if (!pairing) {
      pairing = pairWith(origin).finally(() => pairings.delete(origin));
      pairings.set(origin, pairing);
    }
    return pairing;
  }

  async function pairWith(origin: string) {
    if (!(await deps.cipher.available())) {
      unavailable.add(origin);
      return;
    }
    let device: PairedDevice;
    try {
      const response = await deps.fetch(new URL(USER_DEVICE_PAIR_PATH, origin).href, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await deps.device()),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Signed out: the next page load after sign-in tries again.
        if (response.status !== 401) unavailable.add(origin);
        return;
      }
      const body = (await response.json()) as Partial<
        Record<keyof UserDevicePairResponse, unknown>
      >;
      if (
        typeof body?.token !== "string" ||
        body.token.length === 0 ||
        body.token.length > MAX_TOKEN_LENGTH ||
        typeof body.deviceId !== "string"
      ) {
        unavailable.add(origin);
        return;
      }
      device = { token: body.token, deviceId: body.deviceId, userId: optionalString(body.userId) };
    } catch {
      return;
    }
    try {
      await removals.get(origin);
      await savePairedDevice(deps.userDataDir, origin, device, deps.cipher);
    } catch {
      // A token that cannot be kept must not stay valid on the server.
      await revokeToken(origin, device.token);
      unavailable.add(origin);
      return;
    }
    paired.set(origin, { deviceId: device.deviceId, userId: device.userId });
    if (current === origin) {
      start(origin, device.token);
      await restoreRouting(origin);
    }
  }

  /**
   * Forgets a saved pairing the signed-in account does not list, such as one revoked while this
   * computer could not hear it or paired for another account, so turning access on pairs afresh.
   * Any doubt, such as being signed out or offline, keeps it.
   */
  async function forgetUnlisted(origin: string) {
    const device = paired.get(origin);
    if (!device?.deviceId) return;
    try {
      const response = await deps.fetch(new URL(USER_DEVICE_PATH, origin).href, {
        method: "GET",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const body = (await response.json()) as { devices?: unknown };
      if (!Array.isArray(body?.devices)) return;
      const listed = body.devices.some(
        (entry) => (entry as { deviceId?: unknown } | null)?.deviceId === device.deviceId,
      );
      if (listed) return;
    } catch {
      return;
    }
    if (paired.get(origin) !== device) return;
    await dropPairing(origin);
  }

  async function dropPairing(origin: string) {
    const token = tokens.get(origin);
    if (client?.origin === origin) disconnect();
    paired.delete(origin);
    tokens.delete(origin);
    untied.delete(origin);
    removals.set(
      origin,
      deletePairedDevice(deps.userDataDir, origin).catch(() => undefined),
    );
    // A token another account still holds must not stay valid once this computer moves on.
    if (token) await revokeToken(origin, token);
  }

  async function revokeToken(origin: string, token: string) {
    try {
      const response = await deps.fetch(new URL(`${USER_DEVICE_PATH}/self`, origin).href, {
        method: "DELETE",
        credentials: "omit",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
    } catch {
      /* The local token is deleted regardless. */
    }
  }

  return {
    /** Switches to a server origin (or none), connecting or pairing unless this computer declined it. */
    async select(origin: string | null) {
      origin = secureHttpOrigin(origin ?? undefined);
      if (origin === current) return;
      const selection = ++generation;
      disconnect();
      current = origin;
      if (origin === null) return;
      const [device, saved] = await Promise.all([
        readPairedDevice(deps.userDataDir, origin, deps.cipher),
        readDeviceChoices(deps.userDataDir, origin),
      ]);
      if (selection !== generation) return;
      // A decline made this launch stands even if saving it failed.
      if (choices.get(origin)?.[0]?.consent !== "declined") choices.set(origin, saved);
      if (device) {
        paired.set(origin, { deviceId: device.deviceId, userId: device.userId });
        untied.set(origin, device.token);
        start(origin, device.token);
        void tieToSignIn(origin);
        void restoreRouting(origin);
      } else {
        paired.delete(origin);
        void pair();
      }
    },
    /** Pairs the current server when it is not paired yet, e.g. once the person signs in. */
    pair,
    state(origin: string): Omit<RakazoDesktopDevice, "name"> | null {
      if (origin !== current) return null;
      return { deviceId: paired.get(origin)?.deviceId ?? null, allowed: isAllowed(origin) };
    },
    /**
     * Turning it on asks with the native prompt and keeps the answer only once this computer is
     * paired; turning it off stops every running and waiting request.
     */
    async setAllowed(origin: string, allowed: boolean) {
      if (origin !== current) return;
      if (!allowed) {
        const saving = decide(origin, "declined");
        if (client?.origin === origin) client.cancelAll();
        await saving;
        return;
      }
      const seen = changes.get(origin);
      if (!isAllowed(origin) && !(await ask(origin))) return;
      if (changes.get(origin) !== seen && choiceFor(origin)?.consent !== "allowed") return;
      unavailable.delete(origin);
      await forgetUnlisted(origin);
      await pairOnce(origin);
      if (!paired.has(origin)) throw new Error("Could not pair this computer");
      if (changes.get(origin) !== seen) return;
      await decide(origin, "allowed");
      await restoreRouting(origin);
    },
    /**
     * Sends the owner's computers' browser traffic out through this computer's network. Only
     * this device's token can turn it on, so pairing comes first; it needs no host access.
     */
    async setRouteTraffic(origin: string, routeTraffic: boolean) {
      if (origin !== current) return;
      if (routeTraffic) {
        unavailable.delete(origin);
        await forgetUnlisted(origin);
        await pairOnce(origin);
      }
      if (!(await putRouteTraffic(origin, routeTraffic))) {
        if (routeTraffic) throw new Error("Could not pair this computer");
        return;
      }
      const device = paired.get(origin);
      // Kept for this account, so the next pairing puts it back.
      if (device) await remember(origin, device.userId, { routeTraffic }).catch(() => undefined);
    },
    close() {
      ++generation;
      current = null;
      disconnect();
    },
  };
}

export type UserDeviceAccess = ReturnType<typeof createUserDeviceAccess>;
