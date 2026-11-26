import { MAX_TRANSCRIPTION_RESPONSE_BYTES, VOICE_RESPONSE_TIMEOUT_MS } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dictation, levelFromRms, MAX_ENDPOINT_RECORDING_MS } from "./dictation.js";
import { ensureVoiceConsent } from "./voice-consent.js";

vi.mock("./voice-consent.js", () => ({
  ensureVoiceConsent: vi.fn(async () => undefined),
  invalidateVoiceConsent: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubRecorderFallback(fetchMock: ReturnType<typeof vi.fn>) {
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
    language: "en-US",
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    },
  );
}

describe("Dictation recorder fallback", () => {
  it("waits for disclosure without using up the provider request deadline", async () => {
    vi.useFakeTimers();
    const consent = deferred<void>();
    vi.mocked(ensureVoiceConsent).mockReturnValueOnce(consent.promise);
    const fetchMock = vi.fn(async () => Response.json({ text: "Synthetic transcript" }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS + 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("transcribing");
    consent.resolve();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("Synthetic transcript"));
  });
  it("does not upload audio when voice disclosure is refused", async () => {
    const fetchMock = vi.fn();
    stubRecorderFallback(fetchMock);
    vi.mocked(ensureVoiceConsent).mockRejectedValueOnce(new Error("Consent refused"));
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(dictation.state.error).toBe("Consent refused"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("stops tracks if hold-to-talk is cancelled while the mic prompt is open", async () => {
    const track = { stop: vi.fn() };
    const grant = deferred<{ getTracks: () => Array<{ stop: () => void }> }>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => grant.promise) },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          started();
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    const listening = dictation.listen({
      mode: "hold",
      transcribe: true,
      onFinal: () => undefined,
    });
    dictation.stop("cancel");
    grant.resolve({ getTracks: () => [track] });
    await listening;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
  });

  it("does not deliver a stale transcript to a newer session", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });

    let transcribe!: (body: { text: string }) => void;
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
          transcribe = (body) => resolve(Response.json(body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const first = vi.fn();
    const second = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: first });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: second });
    transcribe({ text: "stale take" });
    await Promise.resolve();
    await Promise.resolve();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("keeps line breaks in a server transcript with no speech prefix", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "  line one\n\nline two  " }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("line one\n\nline two"));
  });

  it("keeps transcription in the space where recording started", async () => {
    const store = new Map<string, string>([["rakazo:space-id", "space-support"]]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hello" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    store.set("rakazo:space-id", "space-other");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-rakazo-space-id")).toBe("space-support");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("sends Android to the server before the voice status has loaded", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36",
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hola, una prueba" }));
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal });
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hola, una prueba"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("leaves the spoken language for the provider to detect", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36",
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "es-ES",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hola" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", onFinal });
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hola"));

    const sent = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(JSON.parse(String(sent?.body))).not.toHaveProperty("language");
  });

  it("rejects oversized transcription responses without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(MAX_TRANSCRIPTION_RESPONSE_BYTES + 1) },
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() =>
      expect(dictation.state.error).toBe("Transcription response is too large."),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a transcription response body is stalled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(VOICE_RESPONSE_TIMEOUT_MS);

    expect(dictation.state.error).toBe("Transcription request timed out.");
  });

  it("surfaces timeout when fetch rejects with AbortError", async () => {
    // Browsers reject aborted fetch with DOMException AbortError. Matching token
    // means the deadline fired (stop() bumps token first), so this must not stay
    // stuck on "transcribing".
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.error).toBe("Transcription request timed out."));
    expect(dictation.state.status).toBe("idle");
  });

  it("stays silent when stop cancels an in-flight transcription", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(dictation.state.status).toBe("transcribing");

    dictation.stop("cancel");
    await Promise.resolve();
    await Promise.resolve();

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("ignores leftover audio from a replaced recorder", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) =>
      Response.json({ text: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      ondataavailable: ((event: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["new".repeat(400)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    recorders[0]?.ondataavailable?.({
      data: new Blob(["STALE-AUDIO-DATA"], { type: "audio/webm" }),
    });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")) as {
      audioBase64: string;
    };
    const decoded = atob(body.audioBase64);
    expect(decoded).toContain("new");
    expect(decoded).not.toContain("STALE");
  });

  it("returns to idle when the recorder cannot start", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          throw new Error("recorder unavailable");
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBe("recorder unavailable");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("fails visibly when endpoint dictation has no silence detector", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      onFinal: () => undefined,
    });
    expect(started).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.state.error).toMatch(/stop talking/i);
  });

  it.each([["recorder fallback", "", 240, false]] as const)(
    "ends recording after silence: %s",
    async (_name, userAgent, endpointMs, auto) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const level = { current: 0.6 };
      class FakeAnalyser {
        fftSize = 2048;
        getByteTimeDomainData(data: Uint8Array) {
          data.fill(Math.round(128 + level.current * 127));
        }
      }
      class FakeContext {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return new FakeAnalyser();
        }
        close() {
          return Promise.resolve();
        }
        resume() {
          return Promise.resolve();
        }
      }
      vi.stubGlobal("AudioContext", FakeContext);

      const recognition = vi.fn();
      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        userAgent,
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
        language: "en-US",
      });
      const spoken = auto ? "Olá! How are you?" : "hello";
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ text: spoken }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const onFinal = vi.fn();
      const stopped = vi.fn();
      class FakeRecorder {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          stopped();
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
          this.onstop?.();
        }
      }
      vi.stubGlobal("MediaRecorder", FakeRecorder);

      const dictation = new Dictation();
      await dictation.listen({
        mode: "endpoint",
        transcribe: auto ? undefined : true,
        endpointMs,
        onFinal,
      });
      expect(recognition).not.toHaveBeenCalled();
      expect(dictation.state.status).toBe("listening");
      await vi.advanceTimersByTimeAsync(80);
      level.current = 0;
      await vi.advanceTimersByTimeAsync((endpointMs ?? 1_200) - 80);
      expect(stopped).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onFinal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(80);
      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledExactlyOnceWith(spoken));
      expect(stopped).toHaveBeenCalledOnce();
      expect(track.stop).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "/api/voice/transcribe",
        expect.objectContaining({ method: "POST" }),
      );
      if (auto) {
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
          "language",
        );
      }
      await vi.advanceTimersByTimeAsync(1_200);
      expect(onFinal).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it.each([
    ["a release before the first tick", 0, "running", false],
    ["speech at release between ticks", 80, "running", true],
    ["a context still resuming", 160, "suspended", false],
    ["a context whose resume failed", 160, "suspended", true],
  ])("transcribes %s", async (_label, elapsed, state, speechOrFailure) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let level = 128;
    const read = vi.fn((data: Uint8Array) => data.fill(level));
    vi.stubGlobal(
      "AudioContext",
      class {
        state = state;
        resume() {
          return speechOrFailure
            ? Promise.reject(new Error("Unavailable"))
            : new Promise<void>(() => {});
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return { fftSize: 2048, getByteTimeDomainData: read };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(elapsed);
    if (state === "running" && speechOrFailure) level = 200;
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));
    expect(fetchMock).toHaveBeenCalledOnce();
    if (state === "suspended") expect(read).not.toHaveBeenCalled();
    else expect(read).toHaveBeenCalledTimes(elapsed / 80 + 1);
  });

  it("skips a hold recording that never rose above the speech threshold", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "Meow!" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(160);
    dictation.submitHold();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toMatch(/didn't catch that/i);
    expect(Reflect.get(dictation, "chunks")).toEqual([]);
    expect(Reflect.get(dictation, "media")).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("transcribes a hold recording that did rise above the speech threshold", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello there" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    await vi.advanceTimersByTimeAsync(160);
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledExactlyOnceWith("hello there"));
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ["sends a recording that never goes quiet", 0.6, "hello"],
    ["drops a recording that never heard speech", 0, ""],
  ])("%s once it reaches the length cap", async (_case, loudness, final) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 2048,
            getByteTimeDomainData: (data: Uint8Array) =>
              data.fill(Math.round(128 + loudness * 127)),
          };
        }
        close() {
          return Promise.resolve();
        }
      },
    );
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    const seen: boolean[] = [];
    dictation.subscribe(() => seen.push(dictation.recording));
    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal });
    expect(dictation.recording).toBe(true);
    expect(seen.at(-1)).toBe(true);
    vi.setSystemTime(Date.now() + MAX_ENDPOINT_RECORDING_MS - 1_000);
    await vi.advanceTimersByTimeAsync(960);
    expect(onFinal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    await Promise.resolve();
    expect(onFinal).toHaveBeenCalledExactlyOnceWith(final);
    expect(fetchMock).toHaveBeenCalledTimes(final ? 1 : 0);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.recording).toBe(false);
  });

  it("does not let a replaced recorder tear down the new silence detector", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "later" }));
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio".repeat(300)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const staleStop = recorders[0]?.onstop;
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    staleStop?.();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("later"));
    vi.useRealTimers();
  });

  it.each(["", "   "])(
    "reports an empty final when endpoint transcription hears nothing (%j)",
    async (text) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const level = { current: 0.6 };
      class FakeAnalyser {
        fftSize = 2048;
        getByteTimeDomainData(data: Uint8Array) {
          data.fill(Math.round(128 + level.current * 127));
        }
      }
      class FakeContext {
        state = "running";
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return new FakeAnalyser();
        }
        close() {
          return Promise.resolve();
        }
        resume() {
          return Promise.resolve();
        }
      }
      vi.stubGlobal("AudioContext", FakeContext);

      const track = { stop: vi.fn() };
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
        language: "en-US",
      });
      const fetchMock = vi.fn(async () => Response.json({ text }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal(
        "MediaRecorder",
        class {
          state = "inactive";
          ondataavailable: ((event: { data: Blob }) => void) | null = null;
          onstop: (() => void) | null = null;
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable?.({
              data: new Blob(["audio".repeat(300)], { type: "audio/webm" }),
            });
            this.onstop?.();
          }
        },
      );

      const onFinal = vi.fn();
      const dictation = new Dictation();
      await dictation.listen({
        mode: "endpoint",
        transcribe: true,
        endpointMs: 240,
        onFinal,
      });
      // A cough, then the quiet gap whose end stops the recording.
      await vi.advanceTimersByTimeAsync(80);
      level.current = 0;
      await vi.advanceTimersByTimeAsync(240);

      await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith(""));
      expect(onFinal).toHaveBeenCalledOnce();
      expect(dictation.state.status).toBe("idle");
      expect(dictation.state.error).toBeUndefined();
      vi.useRealTimers();
    },
  );

  it("reports an empty final when the endpoint recorder captured no audio", async () => {
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(200);
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "never asked" }));
    vi.stubGlobal("fetch", fetchMock);
    const recorders: Array<{ stop: () => void }> = [];
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        constructor() {
          recorders.push(this as unknown as { stop: () => void });
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    // The silence detector ended the turn with nothing on tape.
    recorders[0]?.stop();

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith(""));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("keeps an empty hold final to itself", async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: "" }));
    stubRecorderFallback(fetchMock);
    const onFinal = vi.fn();
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.status).toBe("idle"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.error).toBeUndefined();
  });
});

describe("Dictation through the voice provider only", () => {
  it("asks for a voice provider that transcribes instead of listening without one", async () => {
    stubRecorderFallback(vi.fn());
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: false, onFinal: vi.fn() });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(dictation.state).toMatchObject({
      status: "idle",
      error: "Connect a voice provider that transcribes in Voice settings.",
    });
  });

  it("never uploads a recording that holds only its file header", async () => {
    const fetchMock = vi.fn();
    stubRecorderFallback(fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.ondataavailable?.({ data: new Blob([new Uint8Array(110)], { type: "audio/webm" }) });
          this.onstop?.();
        }
      },
    );
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: vi.fn() });
    dictation.submitHold();
    await vi.waitFor(() => expect(dictation.state.error).toBe("Didn't catch that."));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Dictation waveform level", () => {
  it("keeps room noise flat and loud speech full", () => {
    expect(levelFromRms(0.005)).toBe(0);
    expect(levelFromRms(0.3)).toBe(1);
    expect(levelFromRms(0.05)).toBeGreaterThan(levelFromRms(0.03));
  });

  it("reports loudness while a held recording runs, then silence once it ends", async () => {
    stubRecorderFallback(vi.fn(async () => Response.json({ text: "hi" })));
    const close = vi.fn(async () => undefined);
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        close = close;
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 0,
            getByteTimeDomainData(data: Uint8Array) {
              data.fill(128 + 64);
            },
          };
        }
      },
    );
    const levels: number[] = [];
    const dictation = new Dictation();
    dictation.subscribeLevel((level) => levels.push(level));

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: vi.fn() });
    await vi.waitFor(() => expect(levels.at(-1)).toBe(1));

    dictation.stop("cancel");
    expect(levels.at(-1)).toBe(0);
    // The silence check and the waveform each hold an audio context; both close.
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("leaves calls unmeasured", async () => {
    stubRecorderFallback(vi.fn(async () => Response.json({ text: "hi" })));
    const created = vi.fn();
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          created();
        }
        state = "running";
        close = async () => undefined;
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return { fftSize: 0, getByteTimeDomainData() {} };
        }
      },
    );
    const dictation = new Dictation();
    const level = vi.fn();
    dictation.subscribeLevel(level);

    await dictation.listen({ mode: "endpoint", transcribe: true, onFinal: vi.fn() });

    // Only the silence detector opens audio for a call turn.
    expect(created).toHaveBeenCalledOnce();
    expect(level).not.toHaveBeenCalled();
    dictation.stop("cancel");
  });
});
