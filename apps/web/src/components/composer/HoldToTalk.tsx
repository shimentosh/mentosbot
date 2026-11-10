import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import { ArrowUp, Check, ChevronLeft, ChevronUp, Lock, Mic, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dictation } from "../../lib/dictation";
import { IconTooltip } from "../IconTooltip";

/** How far the finger travels up before the recording locks hands-free. */
export const LOCK_DISTANCE_PX = 64;
/** How far the finger slides toward the start of the line before the recording is discarded. */
export const CANCEL_DISTANCE_PX = 96;
const WAVEFORM_BARS = 14;
/** A press shorter than this is a tap: it keeps listening and writes into the field. */
export const TAP_MS = 350;
const HINT_MS = 2_500;

/** Where the words go: sent as a message, or added to the field to edit first. */
export type DictationTarget = "send" | "field";

/** `fill` sends the words to the field instead of sending them. */
type Recording = { locked: boolean; startedAt: number; fill: boolean } | null;

/**
 * Composer dictation. A tap, or a key press, listens hands-free and writes the words
 * into the field. Holding talks Telegram-style: release to send, or slide up to lock
 * and send by hand. A recording started over a draft always writes into the field,
 * so the draft is never split from what was said.
 */
export function useHoldToTalk({
  transcribe,
  disabled,
  hasDraft,
  onText,
}: {
  transcribe?: boolean;
  disabled?: boolean;
  /** The field already holds words. */
  hasDraft?: boolean;
  onText: (text: string, target: DictationTarget) => void;
}) {
  const [recording, setRecording] = useState<Recording>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [lift, setLift] = useState(0);
  /** Signed sideways travel toward cancel, in pixels; negative in a left-to-right layout. */
  const [slide, setSlide] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recordingRef = useRef(recording);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);
  const hasDraftRef = useRef(hasDraft);
  hasDraftRef.current = hasDraft;
  /** Dictation reported listening for this recording, so a later idle means it ended. */
  const started = useRef(false);
  /** `toward` is -1 when cancel lies to the left, 1 in a right-to-left layout. */
  const gesture = useRef<{
    startX: number;
    startY: number;
    startedAt: number;
    toward: number;
  } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), HINT_MS);
  }, []);

  useEffect(
    () =>
      dictation.subscribe((snapshot) => {
        if (!recordingRef.current) return;
        if (snapshot.status === "listening") started.current = true;
        setTranscript(snapshot.transcript);
        setTranscribing(snapshot.status === "transcribing");
        if (snapshot.status !== "idle" || !started.current) return;
        started.current = false;
        recordingRef.current = null;
        setRecording(null);
        setTranscribing(false);
        setLift(0);
        setSlide(0);
        if (snapshot.error) showNotice(snapshot.error);
      }),
    [showNotice],
  );

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (recordingRef.current) dictation.stop("cancel");
    },
    [],
  );

  const start = useCallback(
    (locked: boolean, fill: boolean) => {
      started.current = false;
      setNotice(null);
      setTranscript("");
      const next = { locked, startedAt: Date.now(), fill: fill || Boolean(hasDraftRef.current) };
      recordingRef.current = next;
      setRecording(next);
      // Dictation goes idle before it reports the words, so read the target from this
      // recording rather than the cleared ref.
      void dictation.listen({
        mode: "hold",
        transcribe,
        onFinal: (text) => onTextRef.current(text, next.fill ? "field" : "send"),
      });
    },
    [transcribe],
  );

  const submit = useCallback(() => {
    if (!recordingRef.current) return;
    dictation.submitHold();
  }, []);

  const cancel = useCallback(() => {
    gesture.current = null;
    started.current = false;
    recordingRef.current = null;
    setRecording(null);
    setTranscribing(false);
    setLift(0);
    setSlide(0);
    dictation.stop("cancel");
  }, []);

  const lock = useCallback((fill = false) => {
    gesture.current = null;
    setLift(0);
    setSlide(0);
    const current = recordingRef.current;
    if (!current) return;
    // Mutate the recording `start` handed to dictation, so its words follow the new target.
    current.locked = true;
    current.fill ||= fill;
    setRecording({ ...current });
  }, []);

  const startHandsFree = useCallback(() => {
    if (disabled || recordingRef.current) return;
    start(true, true);
  }, [disabled, start]);

  return {
    recording,
    transcribing,
    transcript,
    lift,
    slide,
    notice,
    submit,
    cancel,
    startHandsFree,
    buttonProps: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (disabled || event.button !== 0 || recordingRef.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        gesture.current = {
          startX: event.clientX,
          startY: event.clientY,
          startedAt: Date.now(),
          toward: rtl ? 1 : -1,
        };
        start(false, false);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const hold = gesture.current;
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        const up = Math.max(0, hold.startY - event.clientY);
        const across = Math.max(0, (event.clientX - hold.startX) * hold.toward);
        if (up >= LOCK_DISTANCE_PX) {
          lock();
          return;
        }
        if (across >= CANCEL_DISTANCE_PX) {
          cancel();
          return;
        }
        // Only the direction the finger is mostly going moves its target.
        setLift(up > across ? up : 0);
        setSlide(across >= up ? across * hold.toward : 0);
      },
      onPointerUp: () => {
        const hold = gesture.current;
        gesture.current = null;
        setLift(0);
        setSlide(0);
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        // A tap keeps listening hands-free and writes into the field.
        if (Date.now() - hold.startedAt < TAP_MS) {
          lock(true);
          return;
        }
        submit();
      },
      onPointerCancel: () => {
        if (!gesture.current) return;
        gesture.current = null;
        if (!recordingRef.current?.locked) cancel();
      },
      onClick: (event: { detail: number }) => {
        // detail 0 is a keyboard press; pointer presses are handled above.
        if (event.detail === 0) startHandsFree();
      },
      onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    },
  };
}

function useSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Loudness bars that scroll as the microphone hears; hidden until a level arrives. */
function MicWaveform() {
  const [bars, setBars] = useState<{ id: number; level: number }[] | null>(null);
  useEffect(() => {
    let id = 0;
    return dictation.subscribeLevel((level) => {
      setBars((current) => {
        // Nothing measures this recording (a browser without access), so show nothing.
        if (!current && level === 0) return current;
        id += 1;
        const filled =
          current ??
          Array.from({ length: WAVEFORM_BARS }, (_, index) => ({ id: -index, level: 0 }));
        return [...filled.slice(1), { id, level }];
      });
    });
  }, []);
  if (!bars) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="mic-waveform"
      className="flex h-4 shrink-0 items-center gap-0.5 text-foreground/55"
    >
      {bars.map((bar) => (
        <span
          key={bar.id}
          className="w-0.5 rounded-full bg-current transition-[height] duration-75 motion-reduce:transition-none"
          style={{ height: `${Math.round(3 + bar.level * 13)}px` }}
        />
      ))}
    </span>
  );
}

/**
 * Takes the text field's place while recording: a live dot, the time, the waveform, and what
 * was heard. While held, it slides away with the finger toward cancel.
 */
export function HoldToTalkStrip({ talk }: { talk: ReturnType<typeof useHoldToTalk> }) {
  const { t } = useLingui();
  const startedAt = talk.recording?.startedAt ?? Date.now();
  const seconds = useSeconds(startedAt);
  if (!talk.recording) return null;
  const holding = !talk.recording.locked && !talk.transcribing;
  const progress = Math.min(1, Math.abs(talk.slide) / CANCEL_DISTANCE_PX);
  return (
    <div
      data-testid="hold-to-talk-strip"
      className="flex min-h-6 min-w-0 flex-1 items-center gap-2.5 overflow-hidden py-0.5 text-sm"
      style={
        talk.slide ? { translate: `${talk.slide}px 0`, opacity: 1 - progress * 0.7 } : undefined
      }
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="shrink-0 tabular-nums text-foreground/80">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
      {talk.transcribing ? null : <MicWaveform />}
      {talk.transcript ? (
        <span className="min-w-0 flex-1 truncate text-foreground" dir="auto" aria-live="polite">
          {talk.transcript}
        </span>
      ) : holding ? null : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
          {talk.transcribing ? t`Transcribing…` : t`Listening…`}
        </span>
      )}
      {holding ? (
        <span className="ms-auto flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
          <ChevronLeft
            aria-hidden="true"
            size={14}
            strokeWidth={1.8}
            className="animate-pulse rtl:rotate-180"
          />
          {t`Slide to cancel`}
        </span>
      ) : null}
    </div>
  );
}

/** The microphone button, plus the lock target above it and Cancel/Send once locked. */
export function HoldToTalkControls({
  talk,
  disabled,
}: {
  talk: ReturnType<typeof useHoldToTalk>;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { recording } = talk;
  if (recording?.locked) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Discard recording`}
          onClick={talk.cancel}
          className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </Button>
        <Button
          size="icon"
          aria-label={recording.fill ? t`Add to message` : t`Send recording`}
          disabled={talk.transcribing}
          onClick={talk.submit}
          className="size-8 shrink-0 rounded-full shadow-sm"
        >
          {recording.fill ? (
            <Check size={16} strokeWidth={2.2} />
          ) : (
            <ArrowUp size={16} strokeWidth={2.2} />
          )}
        </Button>
      </>
    );
  }
  return (
    <span
      className="relative inline-flex"
      style={talk.slide ? { translate: `${talk.slide}px 0` } : undefined}
    >
      {recording ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full start-1/2 mb-3 flex flex-col items-center gap-0.5 rounded-full border border-border bg-card px-2 py-2 text-muted-foreground shadow-md transition-transform"
          style={{ transform: `translate(-50%, ${-talk.lift}px)` }}
        >
          <Lock size={14} strokeWidth={1.8} />
          <ChevronUp size={14} strokeWidth={1.8} className="animate-bounce" />
        </span>
      ) : null}
      {talk.notice && !recording ? (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full end-0 mb-2 w-max max-w-64 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-md"
        >
          {talk.notice}
        </span>
      ) : null}
      <IconTooltip label={t`Tap to dictate, hold to send`}>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Dictate`}
          disabled={disabled}
          {...talk.buttonProps}
          className={cn(
            "size-8 shrink-0 touch-none select-none rounded-full text-foreground/75 [-webkit-touch-callout:none]",
            // The pointer is over the button while holding, so the outline variant's hover
            // colours (a grey fill in dark, dark text) must not win over the recording red.
            recording &&
              "scale-125 border-destructive-fill bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill hover:text-destructive-foreground dark:hover:bg-destructive-fill",
          )}
        >
          <Mic size={16} strokeWidth={1.8} />
        </Button>
      </IconTooltip>
    </span>
  );
}
