import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  getObjectStorageSettings,
  getObjectStorageUsage,
  updateObjectStorageSettings,
} from "./object-storage-config.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

const input = {
  endpoint: "https://storage.example.com",
  bucket: "rakazo-files",
  region: "",
  prefix: "",
  pathStyle: true,
  accessKeyId: "key-id",
  secretAccessKey: "key-secret",
};

/** An in-memory deployment settings row and secret table behind the calls the config makes. */
function makeDeps(options: { admin?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const state = {
    settings: null as null | { objectStorageCipher: string | null },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: { objectStorageCipher: string } }) => {
        state.settings = { ...state.settings, ...update };
        return state.settings;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const verify = vi.fn(async () => {});
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `secret-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => state.secrets.get(ciphertext) ?? ""),
      delete: vi.fn(async (ciphertext: string) => {
        state.secrets.delete(ciphertext);
      }),
    },
    env: { adminEmails: options.admin === false ? [] : ["admin@example.com"] },
    resolveHostname: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    verify,
    processEnv: options.env ?? {},
  };
  return { deps, state, verify };
}

describe("object storage settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getObjectStorageSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(updateObjectStorageSettings(deps, actor, input)).rejects.toThrow("Admins only");
    await expect(getObjectStorageUsage(deps, actor)).rejects.toThrow("Admins only");
  });

  it("starts on local disk", async () => {
    const { deps } = makeDeps();
    expect(await getObjectStorageSettings(deps, actor)).toMatchObject({
      source: "none",
      active: true,
      bucket: "",
      hasSecret: false,
    });
  });

  it("saves a bucket that accepts a write, encrypted, and never returns its secret", async () => {
    const { deps, state, verify } = makeDeps();
    const saved = await updateObjectStorageSettings(deps, actor, input);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "rakazo-files", region: "us-east-1", pathStyle: true }),
    );
    expect(saved).toMatchObject({
      source: "settings",
      // This process still runs on local disk until it restarts onto the bucket.
      active: false,
      bucket: "rakazo-files",
      accessKeyId: "key-id",
      hasSecret: true,
    });
    expect(JSON.stringify(saved)).not.toContain("key-secret");
    const cipher = state.settings?.objectStorageCipher;
    expect(cipher).toBeTruthy();
    expect(JSON.parse(state.secrets.get(cipher!)!)).toMatchObject({
      secretAccessKey: "key-secret",
    });
    expect(await getObjectStorageSettings(deps, actor)).toMatchObject({ source: "settings" });
  });

  it("saves nothing when the bucket refuses the check", async () => {
    const { deps, state, verify } = makeDeps();
    verify.mockRejectedValueOnce(new Error("AccessDenied for key-secret"));
    const error = await updateObjectStorageSettings(deps, actor, input).catch((e) => e);
    expect(error.message).toBe("Could not write to this bucket");
    expect(state.settings).toBeNull();
    expect(state.secrets.size).toBe(0);
  });

  it("keeps the saved secret when it is left blank and replaces the old ciphertext", async () => {
    const { deps, state, verify } = makeDeps();
    await updateObjectStorageSettings(deps, actor, input);
    const first = state.settings?.objectStorageCipher;
    await updateObjectStorageSettings(deps, actor, {
      ...input,
      accessKeyId: "rotated-id",
      secretAccessKey: "",
    });
    expect(verify).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessKeyId: "rotated-id", secretAccessKey: "key-secret" }),
    );
    expect(state.secrets.has(first!)).toBe(false);
    expect(state.secrets.size).toBe(1);
  });

  it("asks for a secret the first time", async () => {
    const { deps } = makeDeps();
    await expect(
      updateObjectStorageSettings(deps, actor, { ...input, secretAccessKey: "" }),
    ).rejects.toThrow("Enter the secret access key");
  });

  it("keeps the bucket, endpoint and prefix that saved files are in", async () => {
    const { deps } = makeDeps();
    await updateObjectStorageSettings(deps, actor, input);
    for (const change of [
      { bucket: "other" },
      { endpoint: "https://other.example.com" },
      { prefix: "nested" },
    ])
      await expect(
        updateObjectStorageSettings(deps, actor, { ...input, ...change }),
      ).rejects.toThrow("Saved files are in this bucket");
  });

  it("refuses private endpoints", async () => {
    const { deps, verify } = makeDeps();
    deps.resolveHostname.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(updateObjectStorageSettings(deps, actor, input)).rejects.toThrow(
      "Could not write to this bucket",
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("shows but never replaces a bucket set by the server environment", async () => {
    const env = {
      OBJECT_STORAGE_BUCKET: "env-bucket",
      OBJECT_STORAGE_ACCESS_KEY_ID: "env-id",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "env-secret",
    };
    const { deps } = makeDeps({ env });
    const view = await getObjectStorageSettings(deps, actor);
    expect(view).toMatchObject({ source: "environment", bucket: "env-bucket", hasSecret: true });
    expect(JSON.stringify(view)).not.toContain("env-secret");
    await expect(updateObjectStorageSettings(deps, actor, input)).rejects.toThrow(
      "Storage is set by the server environment",
    );
  });

  it("measures only the bucket the server runs on", async () => {
    const { deps } = makeDeps();
    const usage = { bytes: 10, objects: 1, homes: 10, artifacts: 0, partial: false };
    const measure = vi.fn(async () => usage);
    expect(await getObjectStorageUsage({ ...deps, measure }, actor)).toBeNull();
    const running = { source: "settings" as const, config: { ...input, prefix: "" } };
    expect(
      await getObjectStorageUsage({ ...deps, measure, objectStorage: running }, actor),
    ).toEqual(usage);
    expect(measure).toHaveBeenCalledWith(running.config);
    await expect(
      getObjectStorageUsage(
        {
          ...deps,
          objectStorage: running,
          measure: vi.fn(async () => Promise.reject(new Error("key-secret"))),
        },
        actor,
      ),
    ).rejects.toThrow("Could not read this bucket");
  });
});
