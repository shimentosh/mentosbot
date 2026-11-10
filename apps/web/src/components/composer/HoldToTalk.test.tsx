// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationSnapshot } from "../../lib/dictation";
import { dictation } from "../../lib/dictation";
import type { DictationTarget } from "./HoldToTalk";
import {
  CANCEL_DISTANCE_PX,
  HoldToTalkControls,
  HoldToTalkStrip,
  LOCK_DISTANCE_PX,
  TAP_MS,
  useHoldToTalk,
} from "./HoldToTalk";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const watchers = new Set<(snapshot: DictationSnapshot) => void>();
const levelWatchers = new Set<(level: number) => void>();
let onFinal: ((text: string) => void) | null = null;
let transcript = "";

function emit(snapshot: DictationSnapshot) {
  for (const watcher of [...watchers]) watcher(snapshot);
}

vi.mock("../../lib/dictation", () => ({
  dictation: {
    subscribeLevel: vi.fn((watcher: (level: number) => void) => {
      levelWatchers.add(watcher);
      return () => levelWatchers.delete(watcher);
    }),
    subscribe: vi.fn((watcher: (snapshot: DictationSnapshot) => void) => {
      watchers.add(watcher);
      watcher({ status: "idle", transcript: "" });
      return () => watchers.delete(watcher);
    }),
    listen: vi.fn(async (opts: { onFinal: (text: string) => void }) => {
      onFinal = opts.onFinal;
      emit({ status: "listening", transcript: "" });
    }),
    submitHold: vi.fn(() => {
      const final = onFinal;
      onFinal = null;
      emit({ status: "idle", transcript: "" });
      if (transcript) final?.(transcript);
    }),
    stop: vi.fn(() => {
      onFinal = null;
      emit({ status: "idle", transcript: "" });
    }),
  },
}));

function Harness({
  onText,
  hasDraft,
}: {
  onText: (text: string, target: DictationTarget) => void;
  hasDraft?: boolean;
}) {
  const talk = useHoldToTalk({ transcribe: false, hasDraft, onText });
  return (
    <div>
      <HoldToTalkStrip talk={talk} />
      <HoldToTalkControls talk={talk} />
    </div>
  );
}

describe("hold to talk", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onText = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    transcript = "";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness onText={onText} />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    watchers.clear();
    levelWatchers.clear();
    vi.useRealTimers();
  });

  function button(name: string) {
    const found = container?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    if (!found) throw new Error(`Missing button: ${name}`);
    return found;
  }

  function pointer(target: Element, type: string, clientY = 400, clientX = 300) {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
    });
  }

  function heard(text: string) {
    transcript = text;
    act(() => emit({ status: "listening", transcript: text }));
  }

  it("sends what was said when the hold is released", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown");
    expect(dictation.listen).toHaveBeenCalledWith(expect.objectContaining({ mode: "hold" }));
    heard("buy milk tomorrow");
    expect(container?.textContent).toContain("buy milk tomorrow");

    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup");

    expect(dictation.submitHold).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("buy milk tomorrow", "send");
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("keeps listening after a tap and adds the words to the field", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown");
    pointer(mic, "pointerup");

    expect(dictation.submitHold).not.toHaveBeenCalled();
    expect(dictation.stop).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Listening…");
    heard("pick up the dry cleaning");
    expect(onText).not.toHaveBeenCalled();

    act(() => button("Add to message").click());
    expect(onText).toHaveBeenCalledWith("pick up the dry cleaning", "field");
  });

  it("adds a held recording to the field when a draft is already there", () => {
    act(() => root?.render(<Harness onText={onText} hasDraft />));
    const mic = button("Dictate");
    pointer(mic, "pointerdown");
    heard("and the receipts");
    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup");

    expect(onText).toHaveBeenCalledWith("and the receipts", "field");
  });

  it("locks when the hold slides up, then sends only on Send", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown", 400);
    pointer(mic, "pointermove", 400 - LOCK_DISTANCE_PX - 1);
    heard("call the plumber");
    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup", 400 - LOCK_DISTANCE_PX - 1);

    expect(dictation.submitHold).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("call the plumber");

    act(() => button("Send recording").click());
    expect(onText).toHaveBeenCalledWith("call the plumber", "send");
  });

  it("discards the recording when the hold slides toward the start of the line", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown", 400, 300);
    heard("wrong chat");
    expect(container?.textContent).toContain("Slide to cancel");

    pointer(mic, "pointermove", 400, 300 - CANCEL_DISTANCE_PX / 2);
    const strip = container?.querySelector<HTMLElement>('[data-testid="hold-to-talk-strip"]');
    expect(strip?.style.translate).toBe(`${-CANCEL_DISTANCE_PX / 2}px 0`);

    pointer(mic, "pointermove", 400, 300 - CANCEL_DISTANCE_PX - 1);
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();

    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup", 400, 300 - CANCEL_DISTANCE_PX - 1);
    expect(dictation.submitHold).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it("draws the waveform once the microphone reports how loud it is", () => {
    pointer(button("Dictate"), "pointerdown");
    const waveform = () => container?.querySelector('[data-testid="mic-waveform"]');
    // A browser that cannot measure reports nothing, and no flat line stands in for it.
    act(() => {
      for (const watcher of levelWatchers) watcher(0);
    });
    expect(waveform()).toBeNull();

    act(() => {
      for (const watcher of levelWatchers) watcher(1);
    });
    const bars = Array.from(waveform()?.children ?? []) as HTMLElement[];
    expect(bars).toHaveLength(14);
    expect(bars.at(-1)?.style.height).toBe("16px");
    expect(bars[0]?.style.height).toBe("3px");
  });

  it("discards a locked recording", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown", 400);
    pointer(mic, "pointermove", 400 - LOCK_DISTANCE_PX - 1);
    heard("never mind");

    act(() => button("Discard recording").click());

    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(onText).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("dictates into the field from the keyboard, since a key cannot be held", () => {
    act(() => {
      button("Dictate").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });

    expect(dictation.listen).toHaveBeenCalledOnce();
    expect(button("Add to message")).toBeTruthy();
  });

  it("keeps the solid red under the held pointer in both themes", () => {
    const mic = button("Dictate");
    pointer(mic, "pointerdown");
    const classes = mic.className.split(" ");

    // The pointer hovers the button for the whole hold, so the outline hover colours
    // (a grey fill in dark, dark text) must give way to the recording colours.
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-destructive-fill",
        "hover:bg-destructive-fill",
        "dark:hover:bg-destructive-fill",
        "text-destructive-foreground",
        "hover:text-destructive-foreground",
      ]),
    );
    expect(classes).not.toContain("dark:hover:bg-input/50");
    expect(classes).not.toContain("hover:text-foreground");
  });
});
