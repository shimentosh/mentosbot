import { t } from "@lingui/core/macro";
import {
  cancelResponseBody,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  readJsonObjectWithin,
  VOICE_RESPONSE_TIMEOUT_MS,
  withAbort,
} from "@rakazo/core";
import { selectedSpaceId, withSpaceHeaders } from "../query/rpc.js";
import { errorText, voiceAccountErrorText } from "../query/user-error.js";
import { playableRecording } from "./recording-wav.js";
import { ensureVoiceConsent, invalidateVoiceConsent } from "./voice-consent.js";

export type DictationMode = "hold" | "endpoint";

export type DictationSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  error?: string;
};

const IDLE: DictationSnapshot = { status: "idle", transcript: "" };
/**
 * Quiet gap that ends an utterance, measured on the page. Chrome's own end-of-speech
 * fires on any pause, which cuts a caller off mid-sentence; a natural breath is well
 * under this, a finished turn is well over it.
 */
const ENDPOINT_SILENCE_MS = 1200;
const ENDPOINT_TICK_MS = 80;
const SILENCE_RMS = 0.035;
export const MAX_ENDPOINT_RECORDING_MS = 30_000;
/** How often the waveform reads the microphone's loudness. */
const LEVEL_TICK_MS = 70;
/** Room noise sits under the floor; loud speech reaches the ceiling. */
const LEVEL_FLOOR_RMS = 0.01;
const LEVEL_CEILING_RMS = 0.2;

/**
 * Dictation runs only through the connected voice provider, so it is offered once that provider
 * transcribes. `transcribe` is undefined while the voice status loads.
 */
export function dictationAvailable(transcribe: boolean | undefined): boolean {
  return transcribe === true;
}

/**
 * The connected voice provider does all listening; the browser's or desktop's own recognizer is
 * never used. An unknown capability is not a refusal, so a recording made before the voice
 * status loads still goes to the server.
 */
export function usesServerDictation(transcribe: boolean | undefined): boolean {
  return transcribe !== false;
}

/** Smaller than this, a recording holds no audio, only its container's header. */
const MIN_RECORDING_BYTES = 1024;

/** Loudness for the waveform, 0 to 1, spread so quiet speech still shows. */
export function levelFromRms(rms: number): number {
  const loudness = (rms - LEVEL_FLOOR_RMS) / (LEVEL_CEILING_RMS - LEVEL_FLOOR_RMS);
  return Math.sqrt(Math.min(1, Math.max(0, loudness)));
}

function normalizedTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function audioContextCtor(): (new () => AudioContext) | undefined {
  if (typeof AudioContext === "function") return AudioContext;
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { webkitAudioContext?: typeof AudioContext };
  return host.webkitAudioContext;
}

export class Dictation {
  private snapshot: DictationSnapshot = IDLE;
  private watchers = new Set<(s: DictationSnapshot) => void>();
  private levelWatchers = new Set<(level: number) => void>();
  /** Reads loudness for the waveform; `stream` is set when the meter opened its own. */
  private meter: {
    ctx: AudioContext;
    timer: ReturnType<typeof setInterval>;
    stream: MediaStream | null;
  } | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private token = 0;
  private requestCallId: string | undefined;
  private transcribeAbort: AbortController | null = null;
  private audioContext: AudioContext | null = null;
  private vadTimer: ReturnType<typeof setInterval> | undefined;
  private speechSamples = 0;
  private sampleInput: (() => boolean) | undefined;
  private heardSpeech = false;
  private onFinal: ((text: string) => void) | null = null;
  /** Mode of the running session: an endpoint turn reports back even without words. */
  private mode: DictationMode | null = null;

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  /** Microphone loudness, 0 to 1, while a hold recording runs; 0 once it stops. */
  subscribeLevel(fn: (level: number) => void): () => void {
    this.levelWatchers.add(fn);
    return () => {
      this.levelWatchers.delete(fn);
    };
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  get recording(): boolean {
    return this.media?.state === "recording";
  }

  /** A recorder still acquiring its track or capturing, not flushing its last audio. */
  get recordingOrStarting(): boolean {
    return this.recording || (!this.media && this.snapshot.status === "listening");
  }

  private set(next: DictationSnapshot) {
    // Some failures go idle without stop(), and the waveform must not keep the microphone.
    if (next.status === "idle") this.stopMeter();
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  stop(_reason: "submit" | "cancel" | "replace" = "cancel") {
    this.token += 1;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    this.stopVad();
    this.stopMeter();
    const media = this.media;
    this.media = null;
    if (media && media.state !== "inactive") {
      try {
        media.stop();
      } catch {
        // already stopped
      }
    }
    this.chunks = [];
    this.speechSamples = 0;
    this.heardSpeech = false;
    this.onFinal = null;
    this.mode = null;
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async listen(opts: {
    mode: DictationMode;
    callId?: string;
    transcribe?: boolean;
    endpointMs?: number;
    onFinal: (text: string) => void;
  }): Promise<void> {
    this.stop("replace");
    this.requestCallId = opts.callId;
    const mine = this.token;
    const spaceId = selectedSpaceId();
    if (opts.transcribe === false) {
      this.set({
        ...IDLE,
        error: t`Connect a voice provider that transcribes in Voice settings.`,
      });
      return;
    }
    this.onFinal = opts.onFinal;
    this.mode = opts.mode;
    this.set({ status: "listening", transcript: "" });
    const endpointMs = opts.endpointMs ?? ENDPOINT_SILENCE_MS;
    await this.listenRecorder(mine, opts.mode, endpointMs, spaceId);
  }

  private async listenRecorder(
    mine: number,
    mode: DictationMode,
    endpointMs: number,
    spaceId: string | null,
  ) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      this.failListening(mine, errorText(error, t`Microphone failed`));
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.speechSamples = 0;
    this.heardSpeech = false;
    const endpoint = mode === "endpoint";
    const monitoring = this.monitorInput(stream, mine, endpoint ? endpointMs : undefined);
    if (endpoint && !monitoring) {
      for (const track of stream.getTracks()) track.stop();
      this.failListening(
        mine,
        t`This browser can't detect when you stop talking. Use Chrome, the desktop app, or hold-to-talk in the composer.`,
      );
      return;
    }
    let media: MediaRecorder | undefined;
    try {
      media = new MediaRecorder(stream);
      this.media = media;
      this.chunks = [];
      media.ondataavailable = (event) => {
        if (this.token !== mine) return;
        if (event.data.size) this.chunks.push(event.data);
      };
      media.onstop = () => {
        if (this.token === mine) this.sampleInput?.();
        for (const track of stream.getTracks()) track.stop();
        if (this.token !== mine) return;
        this.stopVad();
        this.stopMeter();
        void this.transcribeChunks(mine, spaceId);
      };
      media.start(mode === "endpoint" ? 250 : undefined);
      this.set({ ...this.snapshot });
      if (mode === "hold") this.startMeter(stream, mine, false);
    } catch (error) {
      if (media) {
        media.ondataavailable = null;
        media.onstop = null;
      }
      for (const track of stream.getTracks()) track.stop();
      if (this.media === media) this.media = null;
      if (this.token !== mine) return;
      this.stopVad();
      this.failListening(mine, errorText(error, t`Dictation failed.`));
    }
  }

  /**
   * Watches the microphone level so a recording that never rose above the speech
   * threshold is not sent to a transcription model, which invents text for silence.
   * Endpoint mode also uses it to end the turn after a quiet gap; `endpointMs` is
   * undefined in hold mode, where the caller's release ends the turn.
   */
  private monitorInput(stream: MediaStream, mine: number, endpointMs: number | undefined): boolean {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.audioContext = ctx;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const data = new Uint8Array(analyser.fftSize);
      this.sampleInput = () => {
        if (this.token !== mine || ctx.state !== "running") return false;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) {
          const n = (sample - 128) / 128;
          sum += n * n;
        }
        this.speechSamples += 1;
        const speech = Math.sqrt(sum / data.length) > SILENCE_RMS;
        if (speech) this.heardSpeech = true;
        return speech;
      };
      let silentFor = 0;
      const startedAt = Date.now();
      this.vadTimer = setInterval(() => {
        const media = this.media;
        if (this.token !== mine || !media || media.state === "inactive") return;
        const speaking = this.sampleInput?.();
        const full =
          endpointMs !== undefined && Date.now() - startedAt >= MAX_ENDPOINT_RECORDING_MS;
        if (full && !this.heardSpeech) {
          this.finish(this.snapshot.transcript, mine);
          return;
        }
        if (!full) {
          if (speaking) {
            silentFor = 0;
            return;
          }
          if (endpointMs === undefined || !this.heardSpeech) return;
          silentFor += ENDPOINT_TICK_MS;
          if (silentFor < endpointMs) return;
        }
        this.stopVad();
        try {
          media.stop();
        } catch {
          // already stopped
        }
      }, ENDPOINT_TICK_MS);
      return true;
    } catch {
      this.stopVad();
      return false;
    }
  }

  private startMeter(stream: MediaStream, mine: number, owned: boolean) {
    // A fallback to the recorder replaces the meter's own microphone with the recording's.
    this.stopMeter();
    const release = () => {
      if (owned) for (const track of stream.getTracks()) track.stop();
    };
    const Ctor = audioContextCtor();
    if (this.token !== mine || !this.levelWatchers.size || !Ctor) {
      release();
      return;
    }
    try {
      const ctx = new Ctor();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      if (ctx.state === "suspended") void ctx.resume();
      const data = new Uint8Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) {
          const n = (sample - 128) / 128;
          sum += n * n;
        }
        this.emitLevel(levelFromRms(Math.sqrt(sum / data.length)));
      }, LEVEL_TICK_MS);
      this.meter = { ctx, timer, stream: owned ? stream : null };
    } catch {
      release();
    }
  }

  private stopMeter() {
    const meter = this.meter;
    if (!meter) return;
    this.meter = null;
    clearInterval(meter.timer);
    void meter.ctx.close().catch(() => undefined);
    for (const track of meter.stream?.getTracks() ?? []) track.stop();
    this.emitLevel(0);
  }

  private emitLevel(level: number) {
    for (const watcher of [...this.levelWatchers]) watcher(level);
  }

  private stopVad() {
    clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    this.sampleInput = undefined;
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private async transcribeChunks(mine: number, spaceId: string | null) {
    const requestCallId = this.requestCallId;
    if (this.token !== mine) return;
    // Whisper-style models invent text for silence, so a recording that never rose above
    // the speech threshold is not sent. Require multiple running-context readings so
    // a quick release with only a final sample still gets transcribed.
    if (this.speechSamples >= 2 && !this.heardSpeech) {
      this.chunks = [];
      this.media = null;
      const prefix = normalizedTranscript(this.snapshot.transcript);
      if (prefix) {
        this.finish(prefix, mine);
        return;
      }
      this.set({ ...IDLE, error: t`Didn't catch that.` });
      return;
    }
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (!blob.size) {
      this.finish(normalizedTranscript(this.snapshot.transcript), mine);
      return;
    }
    // A recording stopped before the microphone delivered any sound is only a file header.
    if (blob.size < MIN_RECORDING_BYTES) {
      const prefix = normalizedTranscript(this.snapshot.transcript);
      if (prefix) this.finish(prefix, mine);
      else this.set({ ...IDLE, error: t`Didn't catch that.` });
      return;
    }
    this.set({ status: "transcribing", transcript: this.snapshot.transcript });
    const abort = new AbortController();
    this.transcribeAbort = abort;
    const timedOutMessage = t`Transcription request timed out.`;
    const couldNotTranscribe = t`Could not transcribe that recording.`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ensureVoiceConsent(spaceId, undefined, abort.signal);
      if (this.token !== mine) return;
      timer = setTimeout(() => abort.abort(new Error(timedOutMessage)), VOICE_RESPONSE_TIMEOUT_MS);
      const upload = await playableRecording(blob);
      if (this.token !== mine) return;
      const audioBase64 = await blobToBase64(upload);
      if (this.token !== mine) return;
      const res = await withAbort(
        fetch("/api/voice/transcribe", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({
            audioBase64,
            mimeType: upload.type,
            // The app is in English but people speak their own language, so the provider
            // detects it instead of being told English.
            language: undefined,
            callId: requestCallId,
          }),
          signal: abort.signal,
        }),
        abort.signal,
      );
      if (this.token !== mine) {
        cancelResponseBody(res);
        return;
      }
      const body = await readTranscriptionBody(res, abort.signal);
      if (this.token !== mine) return;
      if (!res.ok) {
        if (body.code === "AI_CONSENT_REQUIRED") invalidateVoiceConsent();
        this.failListening(mine, voiceAccountErrorText(body) ?? body.error ?? couldNotTranscribe);
        return;
      }
      this.finish(body.text ?? "", mine);
    } catch (error) {
      // User cancel bumps token in stop() before aborting, so a matching token
      // means the deadline timer fired. Browsers may reject fetch as AbortError
      // instead of signal.reason; surface the timeout either way.
      if (this.token !== mine) return;
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.failListening(mine, timedOutMessage);
        return;
      }
      this.failListening(mine, errorText(error, couldNotTranscribe));
    } finally {
      clearTimeout(timer);
      if (this.transcribeAbort === abort) this.transcribeAbort = null;
    }
  }

  submitHold() {
    if (this.media && this.media.state !== "inactive") {
      this.media.stop();
      return;
    }
    this.finish(this.snapshot.transcript, this.token);
  }

  private failListening(mine: number, message: string, showError = false) {
    if (this.token !== mine) return;
    const prefix = normalizedTranscript(this.snapshot.transcript);
    if (prefix) {
      this.finish(prefix, mine, showError ? message : undefined);
      return;
    }
    this.set({ ...IDLE, error: message });
  }

  private finish(text: string, mine: number, error?: string) {
    if (this.token !== mine) return;
    const trimmed = text.trim();
    const onFinal = this.onFinal;
    const mode = this.mode;
    this.stop("submit");
    if (error) this.set({ ...IDLE, error });
    if (trimmed) onFinal?.(trimmed);
    // An endpoint session ends with the attempt, words or not. Report the empty turn
    // too, so a caller holding the microphone open starts the next attempt; hold mode
    // watches for idle itself.
    else if (mode === "endpoint") onFinal?.("");
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readTranscriptionBody(response: Response, signal: AbortSignal) {
  return readJsonObjectWithin<{ text?: string; error?: string; code?: string }>(response, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: t`Transcription response is too large.`,
    signal,
  });
}

export const dictation = new Dictation();
