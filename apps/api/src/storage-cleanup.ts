import type { Actor, StorageCleanupInput, StorageCleanupResult } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import { deleteArtifactFamily } from "./artifacts.js";
import type { RouterDeps } from "./router.js";

export type StorageCleanupDeps = Pick<RouterDeps, "prisma" | "artifacts"> & {
  env: Pick<RouterDeps["env"], "adminEmails">;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Families deleted at once: enough to keep a large cleanup moving, few enough for the bucket. */
const CONCURRENCY = 8;

interface OldFamily {
  familyId: string;
  spaceId: string;
  userId: string;
  files: number;
  bytes: bigint;
}

/** A file and all its versions go together, and only once the newest version is past the cutoff. */
async function oldFamilies(prisma: PrismaClient, olderThanDays: number): Promise<OldFamily[]> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY_MS);
  return runAsSystem(
    "find files past the cleanup cutoff",
    () =>
      prisma.$queryRaw<OldFamily[]>`
      SELECT COALESCE("rootArtifactId", id) AS "familyId", "spaceId", "userId",
             count(*)::int AS files, COALESCE(sum(size), 0)::bigint AS bytes
      FROM artifacts
      GROUP BY 1, 2, 3
      HAVING max("createdAt") < ${cutoff}
    `,
  );
}

function total(families: OldFamily[]): StorageCleanupResult {
  return families.reduce(
    (sum, family) => ({ files: sum.files + family.files, bytes: sum.bytes + Number(family.bytes) }),
    { files: 0, bytes: 0 },
  );
}

/** What a cleanup with this cutoff would remove, across every user of the deployment. */
export async function previewStorageCleanup(
  deps: StorageCleanupDeps,
  actor: Actor,
  input: StorageCleanupInput,
): Promise<StorageCleanupResult> {
  await requireAdmin(deps, actor.userId);
  return total(await oldFamilies(deps.prisma, input.olderThanDays));
}

/**
 * Deletes chat and bot files whose newest version is older than the cutoff, each through the same
 * path as deleting it by hand, as its owner. A family that fails is skipped and counted out of the
 * result, so a rerun picks it up.
 */
export async function runStorageCleanup(
  deps: StorageCleanupDeps,
  actor: Actor,
  input: StorageCleanupInput,
): Promise<StorageCleanupResult> {
  await requireAdmin(deps, actor.userId);
  const families = await oldFamilies(deps.prisma, input.olderThanDays);
  if (!families.length) return { files: 0, bytes: 0 };
  const owners = await runAsSystem("read file owners for cleanup", () =>
    deps.prisma.user.findMany({
      where: { id: { in: [...new Set(families.map((family) => family.userId))] } },
      select: { id: true, email: true },
    }),
  );
  const emails = new Map(owners.map((owner) => [owner.id, owner.email]));
  const removed: OldFamily[] = [];
  let failed = 0;
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < families.length; index = next++) {
      const family = families[index]!;
      const owner: Actor = {
        userId: family.userId,
        spaceId: family.spaceId,
        email: emails.get(family.userId) ?? actor.email,
        isDeploymentOwner: false,
      };
      try {
        await runAsTenant(owner, () =>
          deleteArtifactFamily(deps, owner, { familyId: family.familyId }),
        );
        removed.push(family);
      } catch (error) {
        failed += 1;
        getLogger().warn("storage.cleanup.file_failed", {
          "artifact.id": family.familyId,
          "error.name": error instanceof Error ? error.name : typeof error,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, families.length) }, worker));
  const result = total(removed);
  getLogger().info("storage.cleanup.completed", {
    "user.id": actor.userId,
    "storage.cleanup.files": result.files,
    "storage.cleanup.bytes": result.bytes,
    "storage.cleanup.failed": failed,
  });
  return result;
}
