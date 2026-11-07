import { describe, expect, it } from "vitest";
import { availableMemory, containerMemory, readServerUsage } from "./server-usage.js";

describe("server usage", () => {
  it("counts reclaimable cache as available memory", () => {
    const meminfo =
      "MemTotal:       8000000 kB\nMemFree:         100000 kB\nMemAvailable:   3000000 kB\n";
    expect(availableMemory(meminfo, 1)).toBe(3_000_000 * 1024);
    expect(availableMemory(undefined, 42)).toBe(42);
  });

  it("reads a computer's working memory the way docker stats shows it", () => {
    expect(containerMemory({ memory_stats: { usage: 900, stats: { inactive_file: 300 } } })).toBe(
      600,
    );
    expect(
      containerMemory({ memory_stats: { usage: 900, stats: { total_inactive_file: 100 } } }),
    ).toBe(800);
    expect(containerMemory({})).toBeNull();
  });

  it("measures only running computers and survives one that cannot be read", async () => {
    const usage = await readServerUsage({
      dataDir: "/",
      computers: [
        { key: "team-a", running: true, stats: async () => ({ memory_stats: { usage: 500 } }) },
        { key: "team-b", running: true, stats: async () => Promise.reject(new Error("gone")) },
        { key: "bot-c", running: false, stats: async () => ({ memory_stats: { usage: 9 } }) },
      ],
    });
    expect(usage.computers).toEqual([
      { key: "team-a", running: true, memory: 500 },
      { key: "team-b", running: true, memory: null },
      { key: "bot-c", running: false, memory: null },
    ]);
    expect(usage.cpus).toBeGreaterThan(0);
    expect(usage.memory.total).toBeGreaterThan(0);
    expect(usage.disk?.total).toBeGreaterThan(0);
  });
});
