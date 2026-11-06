import type { ObjectStorage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "./object-storage.test-support.js";
import type { S3ObjectStorageConfig } from "./object-storage-settings.js";
import {
  measureObjectStorage,
  objectStorageFingerprint,
  parseObjectStorageConfig,
  resolveObjectStorage,
  verifyObjectStorage,
  watchObjectStorageSettings,
} from "./object-storage-settings.js";

const config: S3ObjectStorageConfig = {
  bucket: "rakazo-files",
  endpoint: "https://storage.example.com",
  region: "us-east-1",
  accessKeyId: "key-id",
  secretAccessKey: "key-secret",
  prefix: "",
  pathStyle: false,
};

function memoryStorage(overrides: Partial<ObjectStorage> = {}) {
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStorage = {
    async put(key, body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
    },
    async *get(key) {
      const value = objects.get(key);
      if (!value) throw new Error("missing");
      yield value;
    },
    async *list() {},
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
    ...overrides,
  };
  return { storage, objects };
}

/** A deployment row whose saved connection decrypts to `saved`, or none. */
function savedIn(saved: S3ObjectStorageConfig | undefined) {
  const state = { saved };
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () =>
        state.saved ? { objectStorageCipher: "cipher" } : { objectStorageCipher: null },
      ),
    },
  } as unknown as PrismaClient;
  const secrets = { load: vi.fn(async () => JSON.stringify(state.saved)) };
  return { prisma, secrets, state };
}

afterEach(() => vi.useRealTimers());

describe("verifyObjectStorage", () => {
  it("writes, reads back and removes one object", async () => {
    const { storage, objects } = memoryStorage();
    const put = vi.spyOn(storage, "put");
    await verifyObjectStorage(config, storage);
    expect(put).toHaveBeenCalledOnce();
    expect(objects.size).toBe(0);
  });

  it("fails, and still cleans up, when the object reads back wrong", async () => {
    const { storage, objects } = memoryStorage({
      async *get() {
        yield new TextEncoder().encode("tampered");
      },
    });
    await expect(verifyObjectStorage(config, storage)).rejects.toThrow("different content");
    expect(objects.size).toBe(0);
  });
});

describe("measureObjectStorage", () => {
  it("adds up every object, split by what it holds", async () => {
    const storage = new MemoryObjectStorage();
    const put = (key: string, size: number) =>
      storage.put(
        key,
        (async function* () {
          yield Buffer.alloc(size);
        })(),
      );
    await put("homes/bot-1/a", 300);
    await put("homes/bot-2/a", 200);
    await put("artifacts/space-1/b", 40);
    await put("other", 5);
    expect(await measureObjectStorage(config, storage)).toEqual({
      bytes: 545,
      objects: 4,
      homes: 500,
      artifacts: 40,
      partial: false,
    });
    expect(await measureObjectStorage(config, storage, 2)).toMatchObject({
      objects: 2,
      partial: true,
    });
  });
});

describe("parseObjectStorageConfig", () => {
  it("round-trips a saved connection", () => {
    expect(parseObjectStorageConfig(JSON.stringify(config))).toEqual(config);
  });

  it("rejects one missing credentials", () => {
    expect(
      parseObjectStorageConfig(JSON.stringify({ ...config, secretAccessKey: "" })),
    ).toBeUndefined();
  });
});

describe("objectStorageFingerprint", () => {
  it("changes with any part of the connection, credentials included", () => {
    const base = objectStorageFingerprint(config);
    expect(objectStorageFingerprint({ ...config })).toBe(base);
    expect(objectStorageFingerprint({ ...config, secretAccessKey: "rotated" })).not.toBe(base);
    expect(objectStorageFingerprint(undefined)).toBe("none");
    expect(base).not.toContain("key-secret");
  });
});

describe("resolveObjectStorage", () => {
  it("prefers the server environment over Settings", async () => {
    const { prisma, secrets } = savedIn(config);
    const resolved = await resolveObjectStorage(prisma, secrets, {
      OBJECT_STORAGE_BUCKET: "env-bucket",
      OBJECT_STORAGE_ACCESS_KEY_ID: "id",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    });
    expect(resolved).toMatchObject({ source: "environment", config: { bucket: "env-bucket" } });
  });

  it("uses Settings, then local disk", async () => {
    expect(await resolveObjectStorage(savedIn(config).prisma, savedIn(config).secrets, {})).toEqual(
      {
        source: "settings",
        config,
      },
    );
    const none = savedIn(undefined);
    expect(await resolveObjectStorage(none.prisma, none.secrets, {})).toBeUndefined();
  });

  it("treats a connection that no longer decrypts as none", async () => {
    const { prisma } = savedIn(config);
    const secrets = { load: vi.fn(async () => Promise.reject(new Error("bad key"))) };
    expect(await resolveObjectStorage(prisma, secrets, {})).toBeUndefined();
  });
});

describe("watchObjectStorageSettings", () => {
  it("asks for one restart when Settings saves a different connection", async () => {
    vi.useFakeTimers();
    const { prisma, secrets, state } = savedIn(undefined);
    const onChange = vi.fn();
    const stop = watchObjectStorageSettings(prisma, secrets, undefined, onChange, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).not.toHaveBeenCalled();
    state.saved = config;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onChange).toHaveBeenCalledOnce();
    stop();
  });

  it("never watches a connection from the environment", async () => {
    vi.useFakeTimers();
    const { prisma, secrets } = savedIn(config);
    const onChange = vi.fn();
    watchObjectStorageSettings(prisma, secrets, { source: "environment", config }, onChange, 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
