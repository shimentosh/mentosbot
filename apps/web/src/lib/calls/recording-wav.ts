/** Speech recognition needs no more than this, and it keeps a WAV upload small. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
/** The server's cap on one recording. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const WAV_HEADER_BYTES = 44;

type AudioLike = {
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
};

/**
 * Chromium's recorder writes WebM without a duration, which some providers reject as
 * corrupt. Decode the recording and upload 16 kHz mono WAV, which every provider reads.
 * Keeps the original when the browser cannot decode it or the WAV would be too large.
 */
export async function playableRecording(blob: Blob): Promise<Blob> {
  const Offline = globalThis.OfflineAudioContext;
  if (typeof Offline !== "function") return blob;
  try {
    // Decoding resamples to the context's rate.
    const decoder = new Offline(1, 1, TRANSCRIPTION_SAMPLE_RATE);
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
    if (!decoded.length || WAV_HEADER_BYTES + decoded.length * 2 > MAX_UPLOAD_BYTES) return blob;
    return new Blob([wavBytes(decoded, TRANSCRIPTION_SAMPLE_RATE)], { type: "audio/wav" });
  } catch {
    return blob;
  }
}

/** 16-bit PCM mono WAV, mixing every channel down to one. */
export function wavBytes(audio: AudioLike, sampleRate: number): Uint8Array<ArrayBuffer> {
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  const dataBytes = audio.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < audio.length; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, channels.length)));
    view.setInt16(WAV_HEADER_BYTES + frame * 2, Math.round(sample * 0x7fff), true);
  }
  return bytes;
}
