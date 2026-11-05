/**
 * Pieces shared by the lookups that read public web pages for chat links (site icons, link
 * previews): a bounded queue, a bounded cache, and the checks that keep fetched bytes and markup
 * from widening what the SSRF-checked fetch already allows.
 */

export const BUSY = Symbol("busy");

/** At most `max` tasks at once; a bounded number wait a bounded time, the rest are BUSY. */
export function concurrencyLimit(max: number, maxWaiting: number, maxWaitMs: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    // Hand the slot straight to the next waiter so a newcomer cannot slip in between.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(task: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (active < max) {
      active += 1;
    } else {
      if (waiting.length >= maxWaiting) return BUSY;
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(admit), 1);
          resolve(false);
        }, maxWaitMs);
        waiting.push(admit);
      });
      if (!admitted) return BUSY;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Answers kept for a while, least recently used dropped first once either the entry count or the
 * summed `sizeOf` passes its cap, so big answers cannot grow the cache past a fixed budget.
 */
export function boundedCache<T>(options: {
  maxEntries: number;
  maxBytes: number;
  sizeOf: (value: T) => number;
  now: () => number;
}) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  let bytes = 0;
  const forget = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= options.sizeOf(entry.value);
    entries.delete(key);
  };
  return {
    /** The live entry, refreshed as most recently used, or undefined once it expires. */
    get(key: string): { value: T } | undefined {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= options.now()) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return { value: entry.value };
    },
    set(key: string, value: T, ttlMs: number) {
      forget(key);
      entries.set(key, { value, expiresAt: options.now() + ttlMs });
      bytes += options.sizeOf(value);
      while (entries.size > options.maxEntries || bytes > options.maxBytes) {
        forget(entries.keys().next().value!);
      }
    },
  };
}

/** The promise's value, or null once the signal aborts, whichever comes first. */
export function untilAborted<T>(
  promise: Promise<T | null>,
  signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(
        (value) => resolve(value),
        () => resolve(null),
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "ico";

/** The raster format the bytes really are, whatever type the server declared. Never SVG. */
export function sniffImage(bytes: Uint8Array): ImageFormat | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 8 && ascii(1, 4) === "PNG" && bytes[0] === 0x89) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  return undefined;
}

/**
 * What relative links in a page resolve against: the first `<base href>`, as a browser would, when
 * it is an http(s) URL, else the page itself. This widens nothing: a page can already name any
 * public host, and every URL read from it still passes the same SSRF and port checks.
 */
export function documentBase(document: ParentNode, pageUrl: string): string {
  const href = document.querySelector("base[href]")?.getAttribute("href") ?? undefined;
  if (href === undefined) return pageUrl;
  try {
    const base = new URL(href.trim(), pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : pageUrl;
  } catch {
    return pageUrl;
  }
}
