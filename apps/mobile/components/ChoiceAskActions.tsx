import type { MessageBlock } from "@rakazo/contracts";
import {
  ASK_USER_OTHER_MAX_LENGTH,
  ASK_USER_PREVIEW_MAX_LENGTH,
  askTextLength,
  encodeAskChoiceAnswer,
} from "@rakazo/contracts";
import { askChoiceAnswerText, askChoiceSelection } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { Fragment, useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** A bot's question with a draft to approve, several options to pick, or room for an own answer. */
export function isRichChoiceAsk(block: AskBlock): boolean {
  return block.preview !== undefined || Boolean(block.multiple) || Boolean(block.other);
}

/**
 * A choice question's draft and controls: the draft quoted and editable, native buttons for the
 * options (latched on a multi-select question, which confirms once), and an own answer field.
 */
export function ChoiceAskActions({
  block,
  canAnswer,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const actions = block.actions ?? [];
  const [draft, setDraft] = useState(block.preview ?? "");
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const answered = block.status === "answered";
  const selection = answered ? askChoiceSelection(block) : undefined;
  const disabled = answered || !canAnswer || pending !== null;
  const shownText = selection ? (selection.edited ?? block.preview) : draft;
  const limit = block.previewLimit;
  const length = askTextLength(shownText ?? "");
  const overLimit = limit !== undefined && length > limit;
  const other = otherText.trim();

  function answerFor(choices: string[], ownAnswer?: string) {
    return encodeAskChoiceAnswer({
      choices,
      ...(ownAnswer !== undefined ? { other: ownAnswer } : {}),
      ...(block.preview !== undefined && draft !== block.preview ? { edited: draft } : {}),
    });
  }
  async function submit(answer: string) {
    if (disabled) return;
    setPending(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(t("Could not submit answer"), errorText(error, t("Please try again.")));
    } finally {
      setPending(null);
    }
  }

  const a11y = { accessibilityActions, onAccessibilityAction };
  const editButton =
    block.preview !== undefined && !answered && canAnswer ? (
      <NativeActionButton
        {...a11y}
        label={t("Edit")}
        prominence="plain"
        disabled={disabled}
        onPress={() => setEditing((value) => !value)}
      />
    ) : null;
  const otherButton =
    block.other && !answered && canAnswer ? (
      <NativeActionButton
        {...a11y}
        label={t("Other…")}
        prominence="secondary"
        fill={!block.preview || Boolean(block.multiple)}
        {...(block.multiple ? { selected: otherOpen } : {})}
        disabled={disabled}
        onPress={() => setOtherOpen((open) => (block.multiple ? !open : true))}
      />
    ) : null;
  // A draft to approve reads as a row of buttons, its first option the primary one.
  const buttonRow = block.preview !== undefined && !block.multiple;

  return (
    <View style={styles.stack}>
      {block.preview !== undefined ? (
        <View style={[styles.preview, { backgroundColor: tokens.muted }]}>
          {editing && !answered ? (
            <TextInput
              accessibilityLabel={t("Draft")}
              multiline
              autoFocus
              maxLength={ASK_USER_PREVIEW_MAX_LENGTH}
              value={draft}
              editable={!disabled}
              onChangeText={setDraft}
              style={[styles.previewText, { color: tokens.foreground }]}
            />
          ) : (
            <Text selectable style={[styles.previewText, { color: tokens.foreground }]}>
              {shownText}
            </Text>
          )}
          {limit !== undefined ? (
            <Text
              style={{
                alignSelf: "flex-end",
                color: overLimit ? tokens.destructive : tokens.mutedForeground,
                fontVariant: ["tabular-nums"],
                ...typeScale.caption,
              }}
            >
              {`${length}/${limit}`}
            </Text>
          ) : null}
        </View>
      ) : null}
      {selection ? (
        <Text
          style={{
            color: tokens.success,
            ...typeScale.secondary,
            fontWeight: fontWeight.medium,
          }}
        >
          {t("Answered: {answer}", { answer: askChoiceAnswerText(block) ?? t("Done") })}
        </Text>
      ) : !canAnswer ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {t("No longer active")}
        </Text>
      ) : (
        <>
          <View style={buttonRow ? styles.row : styles.column}>
            {actions.map((action, index) => {
              const answer = answerFor([action.id]);
              return (
                <Fragment key={action.id}>
                  <NativeActionButton
                    {...a11y}
                    label={action.label}
                    prominence={buttonRow && index === 0 ? "primary" : "secondary"}
                    fill={!buttonRow}
                    {...(block.multiple ? { selected: picked.has(action.id) } : {})}
                    disabled={disabled || (!block.multiple && overLimit)}
                    busy={pending === answer}
                    onPress={() => {
                      if (!block.multiple) return void submit(answer);
                      setPicked((current) => {
                        const next = new Set(current);
                        if (!next.delete(action.id)) next.add(action.id);
                        return next;
                      });
                    }}
                  />
                  {buttonRow && index === 0 ? editButton : null}
                </Fragment>
              );
            })}
            {otherButton}
          </View>
          {otherOpen ? (
            <TextInput
              accessibilityLabel={t("Answer")}
              autoFocus
              value={otherText}
              onChangeText={setOtherText}
              placeholder={t("Type your answer")}
              placeholderTextColor={tokens.faintForeground}
              maxLength={ASK_USER_OTHER_MAX_LENGTH}
              editable={!disabled}
              returnKeyType={block.multiple ? "done" : "send"}
              onSubmitEditing={() => {
                if (!block.multiple && other && !overLimit) void submit(answerFor([], other));
              }}
              style={[styles.field, { borderColor: tokens.border, color: tokens.foreground }]}
            />
          ) : null}
          {block.multiple ? (
            <View style={styles.row}>
              <NativeActionButton
                {...a11y}
                label={t("Done")}
                disabled={disabled || overLimit || (picked.size === 0 && !(otherOpen && other))}
                busy={pending !== null}
                fill={false}
                onPress={() =>
                  void submit(
                    answerFor(
                      actions.filter((action) => picked.has(action.id)).map((action) => action.id),
                      otherOpen && other ? other : undefined,
                    ),
                  )
                }
              />
              {editButton}
            </View>
          ) : otherOpen ? (
            <View style={styles.row}>
              <NativeActionButton
                {...a11y}
                label={t("Send")}
                disabled={disabled || !other || overLimit}
                busy={pending === answerFor([], other)}
                fill={false}
                onPress={() => void submit(answerFor([], other))}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { marginTop: 12, gap: 10 },
  preview: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  previewText: { ...typeScale.body, padding: 0 },
  // Wraps at large text sizes so no button is pushed off the card.
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  column: { gap: 6 },
  field: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
