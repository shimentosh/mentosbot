import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_COMPUTER_MODES,
  BOT_DESCRIPTION_MAX_LENGTH,
  BUILTIN_TOOL_NAMES,
} from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import {
  Button,
  Input,
  OptionSelect,
  SectionHeading,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { ChatModelPicker } from "./chat-model-picker";

export function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {BOT_COMPUTER_MODES.map((mode) => (
        <Toggle
          key={mode}
          variant="outline"
          pressed={value === mode}
          onPressedChange={(pressed) => {
            if (pressed) onChange(mode);
          }}
          className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
        >
          {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
        </Toggle>
      ))}
    </div>
  );
}

/** A panel section: its label, an optional control beside it, then its content. */
export function PanelSection({
  label,
  action,
  children,
}: {
  label: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section>
      <SectionHeading variant="label" className="mb-2 flex min-h-6 items-center justify-between">
        {label}
        {action}
      </SectionHeading>
      {children}
    </section>
  );
}

/** Rows of one card. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-muted/50 px-4 py-1">{children}</div>;
}

export function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-12 cursor-pointer items-center justify-between gap-3 text-body text-foreground"
    >
      {label}
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function humanizeTool(name: string) {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The model row and, when the model offers levels, a thinking row under it. */
export function ModelRow({
  ids,
  containerRef,
  choices,
  value,
  onModelChange,
  thinkingOptions,
  thinkingLevel,
  defaultThinkingLevel,
  onThinkingLevelChange,
}: {
  ids: string;
  containerRef: RefObject<HTMLDivElement | null>;
  choices: readonly ChatModelChoice[];
  value: string;
  onModelChange: (key: string) => void;
  thinkingOptions: ThinkingLevel[];
  thinkingLevel: string;
  defaultThinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: string) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <div ref={containerRef}>
        <ChatModelPicker
          id={`${ids}-model`}
          choices={choices}
          value={value}
          onChange={onModelChange}
        />
      </div>
      {thinkingOptions.length ? (
        <label
          htmlFor={`${ids}-thinking`}
          className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground"
        >
          <Trans>Thinking</Trans>
          <OptionSelect
            id={`${ids}-thinking`}
            className="w-fit max-w-2/3"
            value={thinkingLevel}
            onValueChange={onThinkingLevelChange}
            options={[
              { value: "", label: t`Default (${thinkingLevelLabel(defaultThinkingLevel)})` },
              ...thinkingOptions.map((level) => ({
                value: level,
                label: thinkingLevelLabel(level),
              })),
            ]}
          />
        </label>
      ) : null}
    </>
  );
}

/** The voice that reads replies aloud. */
export function VoiceRow({
  ids,
  voices,
  voiceId,
  onVoiceIdChange,
}: {
  ids: string;
  voices: ReadonlyArray<{ id: string; label: string }>;
  voiceId: string;
  onVoiceIdChange: (voiceId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <label
      htmlFor={`${ids}-voice`}
      className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground"
    >
      <Trans>Voice</Trans>
      <OptionSelect
        id={`${ids}-voice`}
        className="w-fit max-w-2/3"
        value={voiceId}
        onValueChange={onVoiceIdChange}
        options={[
          { value: "", label: t`Account default` },
          ...voices.map((voice) => ({ value: voice.id, label: voice.label })),
        ]}
      />
    </label>
  );
}

/** "A, B and C" in the reader's language. */
function formatList(names: string[]): string {
  return new Intl.ListFormat(i18n.locale || "en", { type: "conjunction" }).format(names);
}

/** On the shared computer: one browser, and its sign-ins, for all the owner's bots, or its own. */
export function BrowserChoice({
  ids,
  global,
  saving,
  error,
  peers,
  onChange,
}: {
  ids: string;
  global: boolean;
  saving: boolean;
  error: string | null;
  /** Names of the owner's other bots on the global browser. */
  peers: string[];
  onChange: (global: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <fieldset className="min-w-0 pt-1 pb-3" aria-describedby={`${ids}-browser-detail`}>
      <legend className="mb-2 text-label font-medium text-muted-foreground">
        <Trans>Browser</Trans>
      </legend>
      <div className="grid grid-cols-2 gap-2">
        {([true, false] as const).map((option) => (
          <Toggle
            key={String(option)}
            variant="outline"
            pressed={global === option}
            disabled={saving}
            onPressedChange={(pressed) => {
              if (!pressed || global === option) return;
              onChange(option);
            }}
            className="aria-pressed:border-foreground/40 aria-pressed:text-foreground"
          >
            {option ? <Trans>Global</Trans> : <Trans>Independent</Trans>}
          </Toggle>
        ))}
      </div>
      <div id={`${ids}-browser-detail`}>
        {error ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        ) : global && peers.length ? (
          <p className="mt-2 truncate text-body-sm text-muted-foreground" title={peers.join(", ")}>
            {t`Shared with ${formatList(peers)}`}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

export function DescriptionGroup({
  ids,
  description,
  onDescriptionChange,
  onCommit,
}: {
  ids: string;
  description: string;
  onDescriptionChange: (description: string) => void;
  /** Saves the description when the field loses focus. */
  onCommit: () => void;
}) {
  const { t } = useLingui();
  return (
    <PanelSection label={t`How other bots see it`}>
      <Textarea
        id={`${ids}-description`}
        aria-label={t`How other bots see it`}
        value={description}
        maxLength={BOT_DESCRIPTION_MAX_LENGTH}
        onChange={(e) => onDescriptionChange(e.target.value)}
        onBlur={onCommit}
        placeholder={t`What this bot is for`}
        rows={2}
        className="min-h-16 max-h-96 resize-none field-sizing-content"
      />
    </PanelSection>
  );
}

/** An https page the bot keeps up to date; the approvals window shows it. */
export function TrackerGroup({
  ids,
  value,
  error,
  onChange,
  onCommit,
}: {
  ids: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  /** Checks and saves the link when the field loses focus. */
  onCommit: () => void;
}) {
  const { t } = useLingui();
  return (
    <PanelSection label={t`Tracker`}>
      <Input
        id={`${ids}-tracker`}
        type="url"
        inputMode="url"
        aria-label={t`Tracker`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${ids}-tracker-error` : undefined}
        value={value}
        maxLength={2048}
        placeholder="https://"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
      />
      {error ? (
        <p
          id={`${ids}-tracker-error`}
          role="alert"
          className="mt-1.5 text-body-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </PanelSection>
  );
}

export function ToolsGroup({
  ids,
  disabledBuiltinTools,
  onDisable,
  onEnable,
}: {
  ids: string;
  disabledBuiltinTools: string[];
  onDisable: (name: string) => void;
  onEnable: (name: string) => void;
}) {
  const { t } = useLingui();
  return (
    <PanelSection label={t`Tools`}>
      <section data-testid="bot-settings-tools">
        <div className="space-y-2 [&>*]:mt-0">
          <div>
            <OptionSelect
              id={`${ids}-disabled-tools`}
              aria-label={t`Disable a tool`}
              value=""
              onValueChange={(name) => {
                if (name) onDisable(name);
              }}
              options={[
                { value: "", label: t`Disable a tool` },
                ...BUILTIN_TOOL_NAMES.filter((name) => !disabledBuiltinTools.includes(name)).map(
                  (name) => ({ value: name, label: humanizeTool(name) }),
                ),
              ]}
            />
          </div>
          {disabledBuiltinTools.map((toolName) => (
            <div
              key={toolName}
              className="flex min-h-11 items-center justify-between gap-3 text-body"
            >
              <span>{humanizeTool(toolName)}</span>
              <Button
                id={`${ids}-disabled-${toolName}`}
                variant="ghost"
                size="icon-xs"
                aria-label={t`Enable ${humanizeTool(toolName)}`}
                title={t`Enable ${humanizeTool(toolName)}`}
                onClick={() => onEnable(toolName)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </PanelSection>
  );
}
