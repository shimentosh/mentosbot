import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_MEMORY_MAX_FACT_CHARS,
  BUILTIN_MEMORY_MAX_FACTS,
  BuiltinMemoryProvider,
  memoryTerms,
  rankMemories,
} from "./builtin-memory-provider.js";

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  shared: boolean;
  generation: number | null;
  content: string;
  createdAt: Date;
};
type Where = Record<string, unknown>;

/** Evaluates the subset of Prisma filters the provider sends: equality, `in`, and `OR`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    const value = row[key as keyof Row];
    if (condition && typeof condition === "object" && "in" in condition) {
      return (condition.in as unknown[]).includes(value);
    }
    return value === condition;
  });
}

function fakeDatabase() {
  const rows: Row[] = [];
  let clock = 0;
  const semanticMemory = {
    async create({ data }: { data: Omit<Row, "id" | "createdAt"> }) {
      clock += 1;
      const row = { ...data, id: `mem-${clock}`, createdAt: new Date(clock * 1000) };
      rows.push(row);
      return row;
    },
    async count({ where }: { where: Where }) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async findMany({ where, take }: { where: Where; take: number }) {
      return rows
        .filter((row) => matches(row, where))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, take);
    },
    async deleteMany({ where }: { where: Where }) {
      const doomed = rows.filter((row) => matches(row, where));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { count: doomed.length };
    },
  };
  return { rows, provider: new BuiltinMemoryProvider({ semanticMemory } as never) };
}

const context = (spaceId = "space-1", userId = "user-1") =>
  ({ spaceId, userId, operationId: "op", traceId: "trace" }) as AdapterContext;

const durable = { kind: "durable" } as const;

async function recall(
  provider: BuiltinMemoryProvider,
  query: string,
  options: { botId?: string; scope?: "isolated" | "shared"; historyGeneration?: number } = {},
  ctx = context(),
) {
  const result = await provider.recall(
    {
      query,
      botId: options.botId ?? "bot-a",
      scope: options.scope ?? "isolated",
      limit: 5,
      ...(options.historyGeneration === undefined
        ? {}
        : { historyGeneration: options.historyGeneration }),
    },
    ctx,
  );
  if (!result.ok) throw new Error(result.error);
  return result.value.map((item) => item.memory);
}

describe("memoryTerms", () => {
  it("keeps Bengali vowel signs inside the word", () => {
    expect(memoryTerms("বাংলায় কথা বলব, Hunter!")).toEqual(["বাংলায়", "কথা", "বলব", "hunter"]);
  });

  it("drops one-letter words but keeps numbers", () => {
    expect(memoryTerms("a 7 to I")).toEqual(["7", "to"]);
  });
});

describe("rankMemories", () => {
  const row = (id: string, content: string, at: number) => ({
    id,
    content,
    createdAt: new Date(at),
  });

  it("does not let a word found in every row pull in unrelated facts", () => {
    const rows = [
      row("1", "The client prefers invoices in USD", 1),
      row("2", "The weekly report goes out on Monday", 2),
      row("3", "The office closes at five", 3),
    ];
    expect(rankMemories("which currency for the invoice", rows, 5).map((r) => r.row.id)).toEqual([
      "1",
    ]);
    expect(rankMemories("the", rows, 5).map((r) => r.row.id)).toEqual(["3", "2", "1"]);
    expect(rankMemories("holiday", rows, 5)).toEqual([]);
  });

  it("keeps facts matching different parts of the question", () => {
    const rows = [
      row("1", "Invoices go out in USD", 1),
      row("2", "The standup meeting is at nine", 2),
      row("3", "Lunch is ordered on Fridays", 3),
    ];
    expect(
      rankMemories("invoice currency and meeting time", rows, 5)
        .map((r) => r.row.id)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("prefers the newer of equally relevant rows and drops duplicates", () => {
    const rows = [
      row("old", "Lead list lives in Sheets", 1),
      row("new", "Lead list lives in Sheets", 2),
      row("other", "Lead source is the press page", 3),
    ];
    expect(rankMemories("lead list", rows, 5).map((r) => r.row.id)).toEqual(["new"]);
  });
});

describe("BuiltinMemoryProvider", () => {
  it("recalls a bot's own facts and not another bot's isolated ones", async () => {
    const { provider } = fakeDatabase();
    await provider.save(
      { content: "Reports go out in English", scope: "isolated", botId: "bot-a", source: durable },
      context(),
    );
    await provider.save(
      {
        content: "Reports are drafted on Fridays",
        scope: "isolated",
        botId: "bot-b",
        source: durable,
      },
      context(),
    );
    expect(await recall(provider, "reports")).toEqual(["Reports go out in English"]);
  });

  it("shares facts saved under the shared scope with the user's other shared bots only", async () => {
    const { provider } = fakeDatabase();
    await provider.save(
      { content: "Noor wants Bangla replies", scope: "shared", botId: "bot-a", source: durable },
      context(),
    );
    expect(await recall(provider, "bangla replies", { botId: "bot-b", scope: "shared" })).toEqual([
      "Noor wants Bangla replies",
    ]);
    expect(await recall(provider, "bangla replies", { botId: "bot-b" })).toEqual([]);
    expect(
      await recall(
        provider,
        "bangla replies",
        { botId: "bot-b", scope: "shared" },
        context("space-1", "teammate"),
      ),
    ).toEqual([]);
    expect(
      await recall(
        provider,
        "bangla replies",
        { botId: "bot-b", scope: "shared" },
        context("space-2"),
      ),
    ).toEqual([]);
  });

  it("recalls chat summaries of the current history generation only, and purges them", async () => {
    const { provider, rows } = fakeDatabase();
    for (const generation of [1, 2]) {
      await provider.save(
        {
          content: `Summary ${generation}: agreed the pricing page copy`,
          scope: "isolated",
          botId: "bot-a",
          source: { kind: "history", generation },
        },
        context(),
      );
    }
    expect(await recall(provider, "pricing copy")).toEqual([]);
    expect(await recall(provider, "pricing copy", { historyGeneration: 2 })).toEqual([
      "Summary 2: agreed the pricing page copy",
    ]);
    await provider.purgeHistory({ botId: "bot-a", generations: [1, 2] }, context());
    expect(rows).toEqual([]);
  });

  it("refuses an oversized fact and a full memory, but keeps saving chat summaries", async () => {
    const { provider, rows } = fakeDatabase();
    const tooLong = await provider.save(
      {
        content: "x".repeat(BUILTIN_MEMORY_MAX_FACT_CHARS + 1),
        scope: "isolated",
        botId: "bot-a",
        source: durable,
      },
      context(),
    );
    expect(tooLong.ok).toBe(false);
    for (let index = 0; index < BUILTIN_MEMORY_MAX_FACTS; index += 1) {
      rows.push({
        id: `seed-${index}`,
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-a",
        shared: false,
        generation: null,
        content: `fact ${index}`,
        createdAt: new Date(0),
      });
    }
    const full = await provider.save(
      { content: "One more", scope: "isolated", botId: "bot-a", source: durable },
      context(),
    );
    expect(full).toMatchObject({ ok: false, error: expect.stringContaining("Memory is full") });
    const summary = await provider.save(
      {
        content: "Summary of older chat",
        scope: "isolated",
        botId: "bot-a",
        source: { kind: "history", generation: 1 },
      },
      context(),
    );
    expect(summary.ok).toBe(true);
  });

  it("forgets only a fact the bot could recall", async () => {
    const { provider, rows } = fakeDatabase();
    await provider.save(
      { content: "Old address", scope: "isolated", botId: "bot-b", source: durable },
      context(),
    );
    const id = rows[0]!.id;
    const denied = await provider.forget({ id, scope: "shared", botId: "bot-a" }, context());
    expect(denied.ok).toBe(false);
    const forgotten = await provider.forget(
      { id, scope: "isolated", botId: "bot-b", reason: "moved" },
      context(),
    );
    expect(forgotten).toEqual({ ok: true, value: { id, expired: true, reason: "moved" } });
    expect(rows).toEqual([]);
  });
});
