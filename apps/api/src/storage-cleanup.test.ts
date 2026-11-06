import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteArtifactFamily } from "./artifacts.js";
import { previewStorageCleanup, runStorageCleanup } from "./storage-cleanup.js";

vi.mock("./artifacts.js", () => ({ deleteArtifactFamily: vi.fn(async () => ({ ok: true })) }));

const actor = {
  userId: "admin",
  spaceId: "space-1",
  email: "admin@example.com",
  isDeploymentOwner: false,
};

const families = [
  { familyId: "file-a", spaceId: "space-1", userId: "admin", files: 2, bytes: 300n },
  { familyId: "file-b", spaceId: "space-2", userId: "teammate", files: 1, bytes: 50n },
];

function makeDeps(admin = true) {
  const queryRaw = vi.fn(async () => families);
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
      findMany: vi.fn(async () => [
        { id: "admin", email: "admin@example.com" },
        { id: "teammate", email: "teammate@example.com" },
      ]),
    },
    $queryRaw: queryRaw,
  };
  return {
    deps: {
      prisma: prisma as unknown as PrismaClient,
      artifacts: {} as never,
      env: { adminEmails: admin ? ["admin@example.com"] : [] },
    },
    queryRaw,
  };
}

beforeEach(() => vi.mocked(deleteArtifactFamily).mockClear());

describe("storage cleanup", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps(false);
    await expect(previewStorageCleanup(deps, actor, { olderThanDays: 30 })).rejects.toThrow(
      "Admins only",
    );
    await expect(runStorageCleanup(deps, actor, { olderThanDays: 30 })).rejects.toThrow(
      "Admins only",
    );
    expect(deleteArtifactFamily).not.toHaveBeenCalled();
  });

  it("previews every old file and its size without deleting", async () => {
    const { deps } = makeDeps();
    expect(await previewStorageCleanup(deps, actor, { olderThanDays: 30 })).toEqual({
      files: 3,
      bytes: 350,
    });
    expect(deleteArtifactFamily).not.toHaveBeenCalled();
  });

  it("deletes each old file as its owner and counts only what was removed", async () => {
    const { deps } = makeDeps();
    // Workers take files in order, so the second call is file-b's.
    vi.mocked(deleteArtifactFamily)
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("bucket unavailable"));
    expect(await runStorageCleanup(deps, actor, { olderThanDays: 30 })).toEqual({
      files: 2,
      bytes: 300,
    });
    expect(deleteArtifactFamily).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ userId: "admin", spaceId: "space-1" }),
      { familyId: "file-a" },
    );
    expect(deleteArtifactFamily).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ userId: "teammate", email: "teammate@example.com" }),
      { familyId: "file-b" },
    );
  });
});
