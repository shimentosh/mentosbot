import * as z from "zod";
import { Id } from "../ids.js";

export const UsageRecordSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  runId: Id.nullable(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable().optional(),
  cacheWriteTokens: z.number().int().nullable().optional(),
  cacheWrite1hTokens: z.number().int().nullable().optional(),
  reasoningTokens: z.number().int().nullable().optional(),
  totalTokens: z.number().int().nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  costSource: z.string().nullable().optional(),
  pricingVersion: z.string().nullable().optional(),
  usageSource: z.string().nullable().optional(),
  callId: z.string().nullable().optional(),
  operationId: z.string().nullable().optional(),
  operationKind: z
    .enum(["answer", "setup", "retrieval", "subagent", "compaction", "image", "video"])
    .optional(),
  parentRunId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsageFigureSchema = z.enum([
  "inputTokens",
  "cachedTokens",
  "outputTokens",
  "totalTokens",
  "costUsd",
]);
export type UsageFigure = z.infer<typeof UsageFigureSchema>;

/**
 * Token and cost totals add up the counted calls that reported the figure, and are null when none
 * did. `partial` names each figure some counted calls left out (an interrupted call, an unpriced
 * model), so the figure is a lower bound.
 */
const UsageFiguresSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable().optional(),
  costUsd: z.number().nullable().optional(),
  modelCalls: z.number().optional(),
});
const partial = z.array(UsageFigureSchema).optional();
const UsageTotalsSchema = UsageFiguresSchema.extend({ partial });
/** Every figure present, as a breakdown row reports them. */
const UsageRowSchema = UsageFiguresSchema.required().extend({ partial });
export const UsageSummarySchema = UsageTotalsSchema.extend({
  runs: z.number(),
  models: z.array(UsageRowSchema.extend({ provider: z.string(), model: z.string() })).optional(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageDateRangeSchema = z.enum(["today", "7d", "30d", "all"]);
export type UsageDateRange = z.infer<typeof UsageDateRangeSchema>;

export const UsageBreakdownInputSchema = z.object({
  /** Omit or null to include every bot. */
  botId: Id.nullish(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  range: UsageDateRangeSchema.default("30d"),
});
export type UsageBreakdownInput = z.infer<typeof UsageBreakdownInputSchema>;

export const UsageBreakdownModelSchema = UsageRowSchema.extend({
  provider: z.string(),
  model: z.string(),
  /** Input read from the provider's cache, which `inputTokens` leaves out; null when no call measured it. */
  cachedTokens: z.number().nullable(),
});
export type UsageBreakdownModel = z.infer<typeof UsageBreakdownModelSchema>;

export const UsageBreakdownPointSchema = UsageRowSchema.extend({
  /** The bucket's first day in the member's timezone, YYYY-MM-DD. */
  date: z.string(),
});
export type UsageBreakdownPoint = z.infer<typeof UsageBreakdownPointSchema>;

export const UsageBreakdownBotSchema = z.object({
  id: Id,
  /** Null for a bot removed without a record of its name. */
  name: z.string().nullable(),
  deleted: z.boolean(),
  runs: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  modelCalls: z.number(),
  partial,
});
export type UsageBreakdownBot = z.infer<typeof UsageBreakdownBotSchema>;

export const UsageBreakdownRoutineSchema = UsageRowSchema.extend({
  /**
   * Null for everything no routine started: chats, messages from other bots, background work,
   * and the runs of a routine that was since deleted.
   */
  id: Id.nullable(),
  name: z.string().nullable(),
  /** The routine's bot, which tells two routines with one name apart. */
  botName: z.string().nullable(),
  runs: z.number(),
});
export type UsageBreakdownRoutine = z.infer<typeof UsageBreakdownRoutineSchema>;

export const UsageBreakdownSchema = z.object({
  range: UsageDateRangeSchema,
  /** Each bot with usage in the range, for the bot selector. */
  bots: z.array(UsageBreakdownBotSchema),
  /** Every model used in the range, for the model selector. */
  modelOptions: z.array(z.object({ provider: z.string(), model: z.string() })),
  totals: UsageRowSchema.extend({ runs: z.number() }),
  models: z.array(UsageBreakdownModelSchema),
  /** The selection split by the routine that started each run, largest first. */
  routines: z.array(UsageBreakdownRoutineSchema),
  /** One point per day, or per month for an all-time history longer than two months. */
  overTimeUnit: z.enum(["day", "month"]),
  overTime: z.array(UsageBreakdownPointSchema),
});
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>;

/** One rolling allowance of a model subscription the member signed in with. */
export const PlanLimitWindowSchema = z.object({
  period: z.enum(["session", "week", "month"]),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
});
export type PlanLimitWindow = z.infer<typeof PlanLimitWindowSchema>;
/** A subscription connection's allowances, as its provider last reported them. */
export const PlanLimitsSchema = z.object({
  credentialId: z.string(),
  /** The subscription's name. */
  name: z.string(),
  /** The connection's own name, which tells two sign-ins to one subscription apart. */
  label: z.string(),
  windows: z.array(PlanLimitWindowSchema).min(1),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

/**
 * How used the subscription with the most room is. Each one is only as open as its fullest
 * allowance, so a nearly spent session on one plan does not read as the member being out.
 */
export function planUsagePercent(plans: readonly PlanLimits[]): number | null {
  if (!plans.length) return null;
  return Math.min(
    ...plans.map((plan) => Math.max(...plan.windows.map((window) => window.usedPercent))),
  );
}
