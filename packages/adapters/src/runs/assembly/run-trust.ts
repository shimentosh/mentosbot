import type { MessageBlock } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  BACKGROUND_HELPER_TRIGGER,
  botMessageContext,
  connectorKindFromToolName,
  HELPER_RESULT_TRIGGER,
  inboundRoutinePrompts,
  SITE_SENDING_TOOLS,
  siteAlwaysAllowed,
} from "@rakazo/core";
import { sitesInText, urlSite } from "@rakazo/core/egress";
import {
  findAutoReviewPreference,
  listApprovalRules,
  readMessageBlocks,
  storedBatchActions,
  storedMessageBlocks,
} from "@rakazo/db";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
} from "../../approvals/approval-effect.js";
import {
  REVIEW_OWNER_MESSAGES,
  REVIEW_OWNER_MESSAGES_WINDOW_MS,
} from "../../approvals/review-owner-messages.js";
import type { EffectiveModelRole } from "../../models/model-roles.js";
import { effectiveModelRole } from "../../models/model-roles.js";
import { routineTaskInstructions } from "../../routines/routine-watch.js";
import { ticketNumberFromWakePrompt } from "../../tasks/ticket-wake.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { CATALOG_APPROVAL_TOOL, PASSED_EFFECT_STATUSES } from "../lifecycle/run-effects.js";
import { loadRunOrigin } from "../lifecycle/run-origin.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "../tools/run-tool-selection.js";
import { modelCreditBillingEnabled } from "../turn/run-model.js";

/**
 * The connection a connector call reaches, for read trust. Installed APIs are told apart by their
 * resource, since their tool names share a prefix; other connectors by their tool-name kind.
 */
function connectorTrustKey(
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
): string {
  return route?.connectorId && route.resourceId
    ? `resource:${route.connectorId}:${route.resourceId}`
    : `kind:${connectorKind}`;
}

/**
 * Read trust for each app a batch reaches, since every batch shares one tool: a Gmail batch must
 * not make a later Slack read trusted, nor one server's batch a batch on another server. An action
 * outside every connected app keys by its own name.
 */
export function connectorTrustKeys(
  batchActions: readonly string[] | undefined,
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
  providers: string[],
): string[] {
  const connection = connectorTrustKey(route, connectorKind);
  if (!batchActions?.length) return [connection];
  const apps = providers.map((provider) => provider.toLowerCase());
  return batchActions.map((name) => {
    const action = name.toLowerCase();
    const app = apps
      .filter((kind) => action === kind || action.startsWith(`${kind}_`))
      .sort((left, right) => right.length - left.length)[0];
    return `${connection}:${app ?? action}`;
  });
}

function blocksOf(blocks: unknown): MessageBlock[] {
  return Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
}

function messageText(blocks: unknown): string {
  return blocksOf(blocks)
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n");
}

function hasBlockKind(blocks: unknown, kind: string): boolean {
  return blocksOf(blocks).some((block) => block.kind === kind);
}

/**
 * The run's own user's answers to its questions, each with the question and the draft it approved.
 * A bare "Post now" handed to another bot says nothing about what was approved. Approval, secret
 * and settings cards are left out: their answers act on their own and are not instructions.
 */
export function ownerAnswerLines(blocks: unknown): string[] {
  return blocksOf(blocks).flatMap((block) => {
    if (block.kind !== "ask" || block.status !== "answered" || !block.answeredByOwner) return [];
    if (block.approvalEffectId || block.input === "secret" || block.dismissed) return [];
    if (block.instructionUpdate || block.settingsUpdate) return [];
    const label = (id: string) => block.actions?.find((action) => action.id === id)?.label ?? id;
    const chosen = block.answers?.length
      ? block.answers.map(label)
      : block.answer
        ? [label(block.answer)]
        : [];
    const answer = [...chosen, block.otherAnswer].filter(Boolean).join("; ");
    if (!answer) return [];
    const draft = block.editedPreview ?? block.preview;
    return [
      [
        `Asked: ${block.text}`,
        ...(draft ? ["Draft on the card:", draft] : []),
        `They answered: ${answer}`,
      ].join("\n"),
    ];
  });
}

/**
 * The owner's words behind the ticket a run was woken for: what they wrote when they created or
 * edited it, or the owner words of their run that had a bot create or hand it on (see
 * Ticket.ownerRequest), and their own comments on it. Someone else's ticket gives only comments.
 */
async function ticketOwnerWords(
  deps: ExecutorDeps,
  run: { userId: string; spaceId: string },
  taskPrompt: string,
): Promise<string> {
  const number = ticketNumberFromWakePrompt(taskPrompt);
  if (number === undefined) return "";
  const ticket = await deps.prisma.ticket.findFirst({
    where: { spaceId: run.spaceId, number, board: { spaceId: run.spaceId } },
    select: {
      ownerRequest: true,
      createdByUserId: true,
      comments: {
        where: { authorUserId: run.userId, authorBotId: null },
        orderBy: { createdAt: "asc" },
        select: { body: true },
      },
    },
  });
  if (!ticket) return "";
  return [
    ...(ticket.createdByUserId === run.userId ? [ticket.ownerRequest ?? ""] : []),
    ...ticket.comments.map((comment) => comment.body),
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

/** Approval and trust lookups a run's tool calls share, each loaded at most once. */
export function createRunTrustLoaders(
  deps: ExecutorDeps,
  input: {
    run: {
      userId: string;
      spaceId: string;
      trigger: string;
      delegatedFromRunId?: string | null;
      threadId?: string;
      sourceMessageId?: string | null;
    };
    runId: string;
    botId: string;
    taskPrompt: string;
    ownerStartedRun: boolean;
    messagingChannelRun: boolean;
    sourceMessage: { id: string; role: string; blocks: unknown } | null;
    /** The owner's own chat-app message that started a messaging run; absent for anyone else. */
    ownerChatMessageBlocks?: MessageBlock[];
    connectedPlugins: readonly { provider: string }[];
  },
) {
  const {
    run,
    runId,
    botId,
    taskPrompt,
    ownerStartedRun,
    messagingChannelRun,
    sourceMessage,
    ownerChatMessageBlocks,
    connectedPlugins,
  } = input;
  let approvalRulesPromise: Promise<ActionApprovalRule[]> | undefined;
  const loadApprovalRules = () => {
    approvalRulesPromise ??= listApprovalRules(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((rules) => rules as ActionApprovalRule[]);
    return approvalRulesPromise;
  };
  let approvalModelPromise: Promise<EffectiveModelRole> | undefined;
  const loadApprovalModel = () =>
    (approvalModelPromise ??= modelCreditBillingEnabled(deps).then((includedApproval) =>
      effectiveModelRole(deps.prisma, { userId: run.userId, spaceId: run.spaceId }, "approval", {
        includedApproval,
      }),
    ));
  let autoReviewPreferencePromise:
    | Promise<{ enabled: boolean; skipApprovals: boolean }>
    | undefined;
  const loadAutoReviewPreference = () => {
    autoReviewPreferencePromise ??= findAutoReviewPreference(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((row) => ({
      enabled: row?.enabled ?? true,
      skipApprovals: row?.skipApprovals ?? false,
    }));
    return autoReviewPreferencePromise;
  };
  // The owner's own words for this run: the message they sent (in Rakazo or their own chat app),
  // or the instructions of the routine that started it, carried along when a bot delegates that
  // work to another (see messageBot). Never a bot, channel or webhook message, or a tool result.
  // These name the sites a run is given, and are all Auto Review sees of a new site's run and of
  // a memory save after outside content.
  let baseOwnerWordsPromise: Promise<string> | undefined;
  const loadBaseOwnerWords = () => {
    baseOwnerWordsPromise ??= (async () => {
      if (run.trigger === BACKGROUND_HELPER_TRIGGER || run.trigger === HELPER_RESULT_TRIGGER) {
        // Delegation inherits privacy; outside speakers cannot authorize owner actions.
        if (messagingChannelRun) return "";
        const origin = await loadRunOrigin(deps.prisma, {
          ...run,
          id: runId,
          botId,
          delegatedFromRunId: run.delegatedFromRunId ?? null,
        });
        const message = origin?.sourceMessage;
        if (
          message?.role !== "user" ||
          message.authorUserId !== run.userId ||
          message.threadId !== origin?.threadId
        )
          return "";
        return messageText(storedMessageBlocks(message));
      }
      // The executor passes chat-app blocks only for the owner's own message.
      const ownerBlocks =
        ownerStartedRun && !messagingChannelRun && sourceMessage?.role === "user"
          ? storedMessageBlocks(sourceMessage)
          : run.trigger === "messaging"
            ? ownerChatMessageBlocks
            : undefined;
      if (ownerBlocks) {
        return messageText(ownerBlocks);
      }
      // Saved when the routine fired, so a later edit cannot change what this run judges.
      if (run.trigger === "routine") return routineTaskInstructions(taskPrompt);
      // Only the server writes this block, copying the sending run's owner words.
      if (run.trigger === "bot_message") {
        const blocks = Array.isArray(sourceMessage?.blocks)
          ? (sourceMessage.blocks as MessageBlock[])
          : [];
        return botMessageContext(blocks)?.userRequest ?? "";
      }
      if (run.trigger === "tickets") return ticketOwnerWords(deps, run, taskPrompt);
      if (run.trigger === "webhook") {
        const routines = await deps.prisma.routine.findMany({
          where: { botId: botId, spaceId: run.spaceId, userId: run.userId },
          select: { name: true, prompt: true },
        });
        return inboundRoutinePrompts(taskPrompt, routines).join("\n\n");
      }
      return "";
    })();
    return baseOwnerWordsPromise;
  };
  // What the owner said to this run after it started: their answers to its questions, with the
  // question and draft they answered, and messages they sent while it worked. Read on each call,
  // since both can arrive while the run is going.
  const loadLaterOwnerWords = async () => {
    const [asked, steered] = await Promise.all([
      deps.prisma.message.findMany({
        where: { runId, role: "bot" },
        orderBy: { createdAt: "asc" },
        select: { blocks: true },
      }),
      messagingChannelRun
        ? []
        : deps.prisma.steeringMessage.findMany({
            where: { runId, botId, claimedAt: { not: null }, originTrigger: null },
            orderBy: { createdAt: "asc" },
            select: { message: { select: { role: true, authorUserId: true, blocks: true } } },
          }),
    ]);
    return [
      ...asked.flatMap((message) => ownerAnswerLines(message.blocks)),
      ...steered.flatMap(({ message }) =>
        message.role === "user" &&
        message.authorUserId === run.userId &&
        !hasBlockKind(message.blocks, "channel_message")
          ? [messageText(message.blocks)].filter(Boolean)
          : [],
      ),
    ];
  };
  // The owner's own words for this run: the message they sent, or the instructions of the
  // routine that started it, carried along when a bot delegates that work to another (see
  // messageBot), and what they told this run since. Never a bot, channel or webhook message, or
  // a tool result. These name the sites a run is given, and are all Auto Review sees of a new
  // site's run.
  const loadOwnerWords = async () => {
    const [base, later] = await Promise.all([loadBaseOwnerWords(), loadLaterOwnerWords()]);
    return [base, ...later].filter((part) => part.trim()).join("\n\n");
  };
  // The owner's own earlier messages in the chat their message started this run from, oldest
  // first. Only their own chat messages count: never a bot's, a channel member's or a tool's.
  let earlierOwnerMessagesPromise: Promise<string[]> | undefined;
  const loadEarlierOwnerMessages = () => {
    earlierOwnerMessagesPromise ??= (async () => {
      // A chat-app run's message is not loaded with the run, so it is read here by the same checks.
      const sourceId =
        sourceMessage?.id ?? (run.trigger === "messaging" ? run.sourceMessageId : undefined);
      if (
        !run.threadId ||
        !ownerStartedRun ||
        messagingChannelRun ||
        !sourceId ||
        run.trigger === BACKGROUND_HELPER_TRIGGER ||
        run.trigger === HELPER_RESULT_TRIGGER
      )
        return [];
      const source = await deps.prisma.message.findUnique({
        where: { id: sourceId },
        select: { seq: true, threadId: true, authorUserId: true, role: true, createdAt: true },
      });
      if (
        source?.role !== "user" ||
        source.threadId !== run.threadId ||
        source.authorUserId !== run.userId
      )
        return [];
      const rows = await deps.prisma.message.findMany({
        where: {
          threadId: run.threadId,
          role: "user",
          authorUserId: run.userId,
          seq: { lt: source.seq },
          createdAt: {
            gte: new Date(source.createdAt.getTime() - REVIEW_OWNER_MESSAGES_WINDOW_MS),
          },
        },
        orderBy: { seq: "desc" },
        // Messages with only files or images hold no words, so look a little further back.
        take: REVIEW_OWNER_MESSAGES * 4,
        select: { id: true, blocks: true },
      });
      const kept: string[] = [];
      for (const row of rows) {
        const read = readMessageBlocks(row);
        // A message that lost entries may have lost the owner's limits, so the reviewer gets no
        // earlier messages rather than a partial history that reads as permission.
        if (!read.intact) return [];
        const text = read.blocks
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("\n");
        if (text.trim()) kept.push(text);
        if (kept.length === REVIEW_OWNER_MESSAGES) break;
      }
      return kept.reverse();
    })();
    return earlierOwnerMessagesPromise;
  };
  let trustedSitesPromise: Promise<Set<string>> | undefined;
  const loadTrustedSites = () => {
    trustedSitesPromise ??= deps.prisma.externalEffect
      .findMany({
        where: {
          runId,
          kind: { in: [...SITE_SENDING_TOOLS] },
          status: { in: PASSED_EFFECT_STATUSES },
        },
        select: { request: true, reviewDecision: true },
      })
      .then(async (rows) => {
        const sites = sitesInText(await loadOwnerWords());
        for (const row of rows) {
          // Auto Review passed that one URL on what it carried; the owner never gave the site.
          if (row.reviewDecision === "pass") continue;
          const url = (row.request as { url?: unknown } | null)?.url;
          const site = typeof url === "string" ? urlSite(url) : undefined;
          if (site) sites.add(site);
        }
        return sites;
      });
    return trustedSitesPromise;
  };
  const routineNamesNewSite = async (prompt: string) => {
    const trusted = await loadTrustedSites();
    const rules = await loadApprovalRules();
    return [...sitesInText(prompt)].some(
      (site) => !trusted.has(site) && !siteAlwaysAllowed(rules, site),
    );
  };
  let trustedConnectorsPromise: Promise<Set<string>> | undefined;
  const loadTrustedConnectors = () => {
    const providers = connectedPlugins.map((plugin) => plugin.provider);
    trustedConnectorsPromise ??= deps.prisma.externalEffect
      .findMany({
        where: { runId, status: { in: PASSED_EFFECT_STATUSES } },
        select: { kind: true, request: true, batchActions: true },
      })
      .then(
        (rows) =>
          new Set(
            rows
              .filter((row) => !BUILTIN_AGENT_TOOL_NAMES.has(row.kind))
              .flatMap((row) =>
                connectorTrustKeys(
                  storedBatchActions(row.batchActions),
                  boundDirectApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route ??
                    catalogApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route,
                  connectorKindFromToolName(row.kind, providers),
                  providers,
                ),
              ),
          ),
      );
    return trustedConnectorsPromise;
  };
  // Channel and webhook text this run took in mid-turn is not the owner's. Rows queued
  // before origins were recorded are recognized by their channel message.
  const receivedOutsideMessage = async () =>
    Boolean(
      await deps.prisma.steeringMessage.findFirst({
        where: {
          runId,
          claimedAt: { not: null },
          OR: [
            { originTrigger: { not: null } },
            { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          ],
        },
        select: { id: true },
      }),
    );
  return {
    loadApprovalRules,
    loadApprovalModel,
    loadAutoReviewPreference,
    loadOwnerWords,
    loadEarlierOwnerMessages,
    loadTrustedSites,
    routineNamesNewSite,
    loadTrustedConnectors,
    receivedOutsideMessage,
  };
}
