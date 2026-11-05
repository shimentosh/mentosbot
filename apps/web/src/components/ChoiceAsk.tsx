import { Trans, useLingui } from "@lingui/react/macro";
import type { AskChoiceAnswer } from "@rakazo/contracts";
import {
  ASK_USER_OTHER_MAX_LENGTH,
  ASK_USER_PREVIEW_MAX_LENGTH,
  askTextLength,
  encodeAskChoiceAnswer,
  parseAskChoiceAnswer,
} from "@rakazo/contracts";
import { askChoiceSelection } from "@rakazo/core";
import { Button, cn, Input, Textarea } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { Fragment, useState } from "react";
import type { AskBlock } from "./AskCard";
import { OptionRow, optionLetter } from "./OptionRow";

/** What the card shows as chosen: the saved answer, or the one just accepted before the block updates. */
function shownSelection(block: AskBlock, acceptedAnswer: string | undefined) {
  if (block.status === "answered") return askChoiceSelection(block);
  if (acceptedAnswer === undefined) return undefined;
  const card = parseAskChoiceAnswer(acceptedAnswer);
  return askChoiceSelection(
    card
      ? {
          ...block,
          answers: card.choices,
          ...(card.other !== undefined ? { otherAnswer: card.other } : {}),
          ...(card.edited !== undefined ? { editedPreview: card.edited } : {}),
        }
      : { ...block, answer: acceptedAnswer },
  );
}

/**
 * A bot's choice question: lettered options, or with a draft to approve, the draft quoted above a
 * row of buttons. The draft can be edited before choosing, a multi-select question confirms once,
 * and an own answer opens a field.
 */
export function ChoiceAsk({
  block,
  canAnswer,
  acceptedAnswer,
  pendingAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  acceptedAnswer?: string;
  pendingAnswer: string | null;
  onAnswer: (answer: string) => void;
}) {
  const { t } = useLingui();
  const actions = block.actions ?? [];
  const [draft, setDraft] = useState(block.preview ?? "");
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const selection = shownSelection(block, acceptedAnswer);
  const answered = selection !== undefined;
  const disabled = answered || !canAnswer || pendingAnswer !== null;
  const chosen = new Set(selection?.chosen.map((action) => action.id));
  const limit = block.previewLimit;
  const shownText = answered ? (selection.edited ?? block.preview) : draft;
  const overLimit = limit !== undefined && askTextLength(shownText ?? "") > limit;
  const other = otherText.trim();

  function answerFor(choices: string[], ownAnswer?: string) {
    const answer: AskChoiceAnswer = {
      choices,
      ...(ownAnswer !== undefined ? { other: ownAnswer } : {}),
      ...(block.preview !== undefined && draft !== block.preview ? { edited: draft } : {}),
    };
    return encodeAskChoiceAnswer(answer);
  }
  function sendingLabel(answer: string, label: string) {
    return pendingAnswer === answer ? <Trans>Sending…</Trans> : label;
  }

  const editButton =
    block.preview !== undefined && !answered ? (
      <Button
        variant="ghost"
        aria-pressed={editing}
        disabled={disabled}
        onClick={() => setEditing((value) => !value)}
      >
        <Trans>Edit</Trans>
      </Button>
    ) : null;
  const otherField =
    otherOpen && !answered ? (
      <form
        className="mt-2 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!block.multiple && other && !overLimit) onAnswer(answerFor([], other));
        }}
      >
        <Input
          aria-label={t`Answer`}
          autoFocus
          maxLength={ASK_USER_OTHER_MAX_LENGTH}
          value={otherText}
          disabled={disabled}
          onChange={(event) => setOtherText(event.target.value)}
          placeholder={t`Type your answer`}
        />
        {block.multiple ? null : (
          <Button type="submit" disabled={disabled || !other || overLimit}>
            {sendingLabel(answerFor([], other), t`Send`)}
          </Button>
        )}
      </form>
    ) : null;
  // A draft to approve reads as a row of buttons, its first option the primary one.
  const buttonRow = block.preview !== undefined && !block.multiple;

  return (
    <>
      {block.preview !== undefined ? (
        <div
          className={cn(
            "mt-3 rounded-lg bg-muted px-3 py-2",
            editing && !answered && "ring-3 ring-ring/50",
          )}
        >
          {editing && !answered ? (
            <Textarea
              aria-label={t`Draft`}
              autoFocus
              maxLength={ASK_USER_PREVIEW_MAX_LENGTH}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-0 rounded-none border-0 bg-transparent p-0 text-[15px] leading-[1.5] focus-visible:ring-0 md:text-[15px] dark:bg-transparent"
            />
          ) : (
            <p
              data-testid="ask-preview"
              className="whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-foreground"
            >
              {shownText}
            </p>
          )}
          {limit !== undefined ? (
            <p
              data-testid="ask-preview-count"
              className={cn(
                "mt-1 text-end text-xs tabular-nums text-muted-foreground",
                overLimit && "text-destructive",
              )}
            >
              {askTextLength(shownText ?? "")}/{limit}
            </p>
          ) : null}
        </div>
      ) : null}
      {buttonRow && answered ? (
        <div className="mt-3 flex items-center gap-1.5 text-[13.5px] font-medium text-muted-foreground">
          <Check aria-hidden className="size-4" />
          {[...selection.chosen.map((action) => action.label), selection.other]
            .filter(Boolean)
            .join(", ") || t`Answered`}
        </div>
      ) : buttonRow ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action, index) => (
              <Fragment key={action.id}>
                <Button
                  variant={index === 0 ? "default" : "ghost"}
                  className="h-auto min-h-8 min-w-0 whitespace-normal py-1 text-start"
                  disabled={disabled || overLimit}
                  onClick={() => onAnswer(answerFor([action.id]))}
                >
                  {sendingLabel(answerFor([action.id]), action.label)}
                </Button>
                {index === 0 ? editButton : null}
              </Fragment>
            ))}
            {block.other ? (
              <Button
                variant="ghost"
                aria-expanded={otherOpen}
                disabled={disabled}
                onClick={() => setOtherOpen(true)}
              >
                <Trans>Other…</Trans>
              </Button>
            ) : null}
          </div>
          {otherField}
        </>
      ) : (
        <>
          {/* Options stay in place once answered: the chosen ones are marked, the rest dim. */}
          <div className="mt-2.5 space-y-0.5">
            {actions.map((action, index) => (
              <OptionRow
                key={action.id}
                letter={optionLetter(index)}
                selected={
                  answered ? chosen.has(action.id) : block.multiple && picked.has(action.id)
                }
                disabled={disabled}
                onClick={() => {
                  if (!block.multiple) return onAnswer(answerFor([action.id]));
                  setPicked((current) => {
                    const next = new Set(current);
                    if (!next.delete(action.id)) next.add(action.id);
                    return next;
                  });
                }}
              >
                {block.multiple ? action.label : sendingLabel(answerFor([action.id]), action.label)}
              </OptionRow>
            ))}
            {block.other ? (
              <OptionRow
                letter={optionLetter(actions.length)}
                selected={answered ? Boolean(selection.other) : block.multiple && otherOpen}
                disabled={disabled}
                onClick={() => setOtherOpen((open) => (block.multiple ? !open : true))}
              >
                {answered && selection.other ? selection.other : <Trans>Other…</Trans>}
              </OptionRow>
            ) : null}
          </div>
          {otherField}
          {block.multiple && !answered ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={disabled || overLimit || (picked.size === 0 && !(otherOpen && other))}
                onClick={() =>
                  onAnswer(
                    answerFor(
                      actions.filter((action) => picked.has(action.id)).map((action) => action.id),
                      otherOpen && other ? other : undefined,
                    ),
                  )
                }
              >
                {pendingAnswer !== null ? <Trans>Sending…</Trans> : <Trans>Done</Trans>}
              </Button>
              {editButton}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
