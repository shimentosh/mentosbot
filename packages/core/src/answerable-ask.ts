import { isSecretAskBlock } from "./action-approval.js";

type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string; input?: string; approvalEffectId?: string }[];
  }[];
  run?: { id: string; status: string; userId?: string } | null;
  activeRuns?: readonly { id: string; status: string; userId?: string }[];
};

export function answerableAskMessageIds(snapshot: AskSnapshot | null): Set<string> {
  const answerable = new Set<string>();
  if (!snapshot) return answerable;
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === "waiting_input")
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (!message.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      answerable.add(message.id);
    }
  }
  return answerable;
}

/** Secret requests can only be dismissed by the user of their run. */
export function dismissableAskMessageIds(
  snapshot: AskSnapshot | null,
  userId?: string,
): Set<string> {
  const dismissable = new Set<string>();
  if (!snapshot || !userId) return dismissable;
  const runs = snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []);
  const ownedRunIds = new Set(
    runs
      .filter((run) => run.status === "waiting_input" && run.userId === userId)
      .map((run) => run.id),
  );
  for (const message of snapshot.messages) {
    if (
      message.runId &&
      ownedRunIds.has(message.runId) &&
      message.blocks.some((block) => isSecretAskBlock(block) && block.status !== "answered")
    ) {
      dismissable.add(message.id);
    }
  }
  return dismissable;
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return resolveAskChoice(answer, actions)?.label ?? answer;
}

export function resolveAskChoice(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): { id: string; label: string } | undefined {
  if (!actions?.length) return undefined;
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const byId = actions.find((action) => action.id === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return actions.find((action) => action.label.trim().toLowerCase() === lower);
}

type ChoiceAction = { id: string; label: string };

type ChoiceAskBlock = {
  text: string;
  answer?: string;
  answers?: readonly string[];
  otherAnswer?: string;
  editedPreview?: string;
  preview?: string;
  actions?: readonly ChoiceAction[];
};

/** What an answered choice question chose: its options, the person's own answer, the edited draft. */
export function askChoiceSelection(block: ChoiceAskBlock): {
  chosen: ChoiceAction[];
  other?: string;
  edited?: string;
} {
  if (block.answers) {
    return {
      chosen: block.answers.flatMap(
        (id) => block.actions?.find((action) => action.id === id) ?? [],
      ),
      ...(block.otherAnswer !== undefined ? { other: block.otherAnswer } : {}),
      ...(block.editedPreview !== undefined ? { edited: block.editedPreview } : {}),
    };
  }
  const chosen = block.answer ? resolveAskChoice(block.answer, block.actions) : undefined;
  return { chosen: chosen ? [chosen] : [] };
}

/** An answered choice question in one line: the chosen labels, then the person's own answer. */
export function askChoiceAnswerText(block: ChoiceAskBlock): string | undefined {
  if (!block.answer && !block.answers) return undefined;
  const { chosen, other } = askChoiceSelection(block);
  const parts = [...chosen.map((action) => action.label), ...(other ? [other] : [])];
  return parts.length ? parts.join(", ") : block.answer;
}

/**
 * A choice question where only text travels: the question, its draft, and numbered options a reply
 * can name.
 */
export function askChoicePlainText(block: ChoiceAskBlock): string {
  return [
    block.text.trim(),
    block.preview?.trim(),
    block.actions?.map((action, index) => `${index + 1}. ${action.label}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
