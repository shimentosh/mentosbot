import { afterEach, describe, expect, it, vi } from "vitest";
import { playableRecording, TRANSCRIPTION_SAMPLE_RATE, wavBytes } from "./recording-wav";

function audio(...channels: number[][]) {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (index: number) => Float32Array.from(channels[index] ?? []),
  };
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wavBytes", () => {
  it("writes a 16-bit mono PCM header with the data size", () => {
    const bytes = wavBytes(audio([0, 0.5, -1]), 16_000);
    const view = new DataView(bytes.buffer);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(ascii(bytes, 8, 16)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(bytes, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect(bytes.byteLength).toBe(50);
    expect([0, 1, 2].map((frame) => view.getInt16(44 + frame * 2, true))).toEqual([
      0, 16384, -32767,
    ]);
  });

  it("mixes stereo down to one channel", () => {
    const bytes = wavBytes(audio([1, 0.5], [0, 0.5]), 16_000);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(view.getInt16(46, true)).toBe(16384);
  });
});

describe("playableRecording", () => {
  const webm = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });

  it("re-encodes a decodable recording as 16 kHz WAV", async () => {
    const rates: number[] = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor(_channels: number, _length: number, rate: number) {
          rates.push(rate);
        }
        decodeAudioData() {
          return Promise.resolve(audio([0, 0.25]));
        }
      },
    );
    const result = await playableRecording(webm);
    expect(result.type).toBe("audio/wav");
    expect(result.size).toBe(48);
    expect(rates).toEqual([TRANSCRIPTION_SAMPLE_RATE]);
  });

  it("keeps the original when the browser cannot decode it", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.reject(new Error("unsupported"));
        }
      },
    );
    await expect(playableRecording(webm)).resolves.toBe(webm);
  });

  it("keeps the original when the WAV would pass the upload cap", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({ numberOfChannels: 1, length: 5_000_000, getChannelData() {} });
        }
      },
    );
    await expect(playableRecording(webm)).resolves.toBe(webm);
  });

  it("keeps the original without an offline audio context", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    await expect(playableRecording(webm)).resolves.toBe(webm);
  });
});
