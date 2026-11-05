import type {
  AdapterContext,
  SemanticMemoryForgetRequest,
  SemanticMemoryForgetResponse,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export const BUILTIN_MEMORY_PROVIDER_ID = "builtin";
/** Facts one bot keeps. Past it a save is refused, so the bot forgets or merges old ones. */
export const BUILTIN_MEMORY_MAX_FACTS = 1000;
/** One saved fact; longer notes belong in instructions, skills or shared memory documents. */
export const BUILTIN_MEMORY_MAX_FACT_CHARS = 2000;
/** Newest rows a recall ranks: a bot's own facts plus shared ones from the user's other bots. */
const RECALL_CANDIDATES = 3000;
/** Shorter terms match too much to rank on a shared prefix. */
const MIN_PREFIX_MATCH = 4;

type MemoryRow = { id: string; content: string; createdAt: Date };

/**
 * Long-term memory kept in this deployment's database, used when no memory provider is
 * connected. Content goes through the client's content encryption, so recall ranks the
 * decrypted rows of one bot (and the user's shared facts) here instead of in SQL.
 */
export class BuiltinMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly prisma: Pick<PrismaClient, "semanticMemory">) {}

  describe() {
    return {
      id: BUILTIN_MEMORY_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true } as const,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    if (memoryTerms(request.query).length === 0 || request.limit < 1) {
      return { ok: true, value: [] };
    }
    const rows = await this.prisma.semanticMemory.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        OR: [
          { botId: request.botId, generation: null },
          ...(request.scope === "shared" ? [{ shared: true, generation: null }] : []),
          ...(request.historyGeneration === undefined
            ? []
            : [{ botId: request.botId, generation: request.historyGeneration }]),
        ],
      },
      select: { id: true, content: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECALL_CANDIDATES,
    });
    return {
      ok: true,
      value: rankMemories(request.query, rows, request.limit).map(({ row, score }) => ({
        id: row.id,
        memory: row.content,
        score,
        updatedAt: row.createdAt.toISOString(),
      })),
    };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const content = request.content.trim();
    if (!content) return { ok: false, error: "content is required" };
    const history = request.source.kind === "history";
    if (!history) {
      if (content.length > BUILTIN_MEMORY_MAX_FACT_CHARS) {
        return {
          ok: false,
          error: `A memory holds at most ${BUILTIN_MEMORY_MAX_FACT_CHARS} characters. Save shorter facts.`,
        };
      }
      const saved = await this.prisma.semanticMemory.count({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          botId: request.botId,
          generation: null,
        },
      });
      if (saved >= BUILTIN_MEMORY_MAX_FACTS) {
        return {
          ok: false,
          error: `Memory is full (${BUILTIN_MEMORY_MAX_FACTS} facts). Recall related facts, forget outdated ones, then save.`,
        };
      }
    }
    await this.prisma.semanticMemory.create({
      data: {
        spaceId: context.spaceId,
        userId: context.userId,
        botId: request.botId,
        shared: !history && request.scope === "shared",
        generation: request.source.kind === "history" ? request.source.generation : null,
        content,
      },
    });
    return { ok: true, value: undefined };
  }

  async purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    await this.prisma.semanticMemory.deleteMany({
      where: {
        spaceId: context.spaceId,
        botId: request.botId,
        generation: { in: [...new Set(request.generations)] },
      },
    });
    return { ok: true, value: undefined };
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryForgetResponse> {
    const id = request.id.trim();
    if (!id) return { ok: false, error: "id is required" };
    // Only a fact this bot could recall: its own, or a shared one when it recalls shared facts.
    const { count } = await this.prisma.semanticMemory.deleteMany({
      where: {
        id,
        spaceId: context.spaceId,
        userId: context.userId,
        generation: null,
        OR: [{ botId: request.botId }, ...(request.scope === "shared" ? [{ shared: true }] : [])],
      },
    });
    if (count === 0) {
      return { ok: false, error: "No memory with that id was found in this bot's memory." };
    }
    return { ok: true, value: { id, expired: true, reason: request.reason ?? null } };
  }
}

/** Lowercased words in any script; combining marks stay inside the word (Bengali vowel signs). */
export function memoryTerms(text: string): string[] {
  return [
    ...new Set(
      (
        text
          .normalize("NFKC")
          .toLowerCase()
          .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
      ).filter((term) => [...term].length >= 2 || /\p{N}/u.test(term)),
    ),
  ];
}

/**
 * Scores each row by the query words it contains, weighting rare words higher (BM25 idf), with
 * half credit for a shared prefix (inflections such as "invoice"/"invoices"). Only rows scoring
 * at least half the best one are kept, so words found almost everywhere do not pull in
 * unrelated facts. Ties go to the newer row.
 */
export function rankMemories<T extends MemoryRow>(
  query: string,
  rows: readonly T[],
  limit: number,
): Array<{ row: T; score: number }> {
  const queryTerms = memoryTerms(query);
  const documents = rows.map((row) => ({ row, terms: memoryTerms(row.content) }));
  const weights = new Map(
    queryTerms.map((term) => {
      const containing = documents.filter((document) => matchStrength(term, document.terms) > 0);
      const frequency = containing.length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }),
  );
  const scored = documents.map(({ row, terms }) => ({
    row,
    score: queryTerms.reduce(
      (sum, term) => sum + matchStrength(term, terms) * (weights.get(term) ?? 0),
      0,
    ),
  }));
  const cutoff = Math.max(0, ...scored.map(({ score }) => score)) / 2;
  const seen = new Set<string>();
  return scored
    .filter(({ score }) => score > 0 && score >= cutoff)
    .sort(
      (left, right) =>
        right.score - left.score || right.row.createdAt.getTime() - left.row.createdAt.getTime(),
    )
    .filter(({ row }) => {
      const key = row.content.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function matchStrength(term: string, terms: readonly string[]): number {
  if (terms.includes(term)) return 1;
  if ([...term].length < MIN_PREFIX_MATCH) return 0;
  return terms.some(
    (candidate) =>
      [...candidate].length >= MIN_PREFIX_MATCH &&
      (candidate.startsWith(term) || term.startsWith(candidate)),
  )
    ? 0.5
    : 0;
}
