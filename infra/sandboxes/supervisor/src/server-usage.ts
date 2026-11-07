import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

/** How busy this server is, so its owner can tell when bots need another one. Bytes throughout. */
export interface ServerUsage {
  cpus: number;
  /** Runnable processes averaged over the last minute; about `cpus` means every core is busy. */
  load: number;
  memory: { total: number; available: number };
  /** The disk that holds the computers' homes, when it could be read. */
  disk: { total: number; available: number } | null;
  /** Each computer by its home key, with what it uses now while running. */
  computers: { key: string; running: boolean; memory: number | null }[];
}

/** Memory the server can still hand out: MemAvailable counts reclaimable cache, MemFree does not. */
export function availableMemory(meminfo: string | undefined, fallback: number): number {
  const kib = meminfo ? /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1] : undefined;
  return kib ? Number(kib) * 1024 : fallback;
}

/** A container's working memory, the figure `docker stats` shows: usage less its file cache. */
export function containerMemory(stats: unknown): number | null {
  const memory = (stats as { memory_stats?: { usage?: number; stats?: Record<string, number> } })
    ?.memory_stats;
  if (typeof memory?.usage !== "number") return null;
  const cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0;
  return Math.max(0, memory.usage - cache);
}

export async function readServerUsage(input: {
  dataDir: string;
  computers: { key: string; running: boolean; stats?: () => Promise<unknown> }[];
}): Promise<ServerUsage> {
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => undefined);
  const disk = await statfs(input.dataDir).then(
    (fs) => ({ total: fs.blocks * fs.bsize, available: fs.bavail * fs.bsize }),
    () => null,
  );
  const computers = await Promise.all(
    input.computers.map(async (computer) => ({
      key: computer.key,
      running: computer.running,
      memory:
        computer.running && computer.stats
          ? containerMemory(await computer.stats().catch(() => undefined))
          : null,
    })),
  );
  return {
    cpus: os.availableParallelism(),
    load: os.loadavg()[0] ?? 0,
    memory: { total: os.totalmem(), available: availableMemory(meminfo, os.freemem()) },
    disk,
    computers,
  };
}
