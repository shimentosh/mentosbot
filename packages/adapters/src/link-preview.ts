import type { LinkPreview } from "@rakazo/contracts";
import { LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import { JSDOM } from "jsdom";
import type { ResolveHostname } from "./network-address.js";
import {
  BUSY,
  boundedCache,
  concurrencyLimit,
  documentBase,
  sniffImage,
  untilAborted,
} from "./site-lookup.js";
import { fetchSafeWebBytes } from "./web-ssrf.js";

/** Pages put their card tags in the head, well inside this; the rest is never read. */
const PAGE_MAX_BYTES = 512 * 1024;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = [80, 443] as const;
const MAX_CONCURRENT = 4;
const MAX_WAITING = 32;
const MAX_WAIT_MS = 4_000;
/** Lookups one requester may have queued or running; links already being read join for free. */
const MAX_PER_REQUESTER = 4;
/** One budget for the page and its image, so a slow site cannot hold a slot for every timeout. */
const LOOKUP_DEADLINE_MS = 10_000;
const MAX_CACHED_LINKS = 2_000;
/** Images dominate an answer's size, so the byte budget, not the link count, usually binds. */
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
const FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const MISSING_TTL_MS = 60 * 60 * 1000;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 300;
const SITE_NAME_MAX = 60;
/** Larger declared images are refused before their pixels are decoded. */
const MAX_INPUT_PIXELS = 12_000_000;
/** Narrower images are usually a logo or an avatar; the card shows the site icon instead. */
const MIN_IMAGE_WIDTH = 200;
/** Only landscape images fill the card's wide frame without losing most of the picture. */
const MIN_IMAGE_ASPECT = 1.3;
const IMAGE_OUTPUT_WIDTH = 640;
const MAX_IMAGE_DATA_URL_LENGTH = 256 * 1024;

/** `retry` marks a null that only means the server was too busy to look, so ask again later. */
export type LinkPreviewAnswer = { preview: LinkPreview | null; retry?: true };

export type LinkPreviewResolver = {
  /** `requester` scopes the per-person limit, so one reader cannot take every slot. */
  preview(url: string, requester?: string): Promise<LinkPreviewAnswer>;
};

export type LinkPreviewResolverOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
  /** Test seams for the queue, deadline and cache; the defaults suit production. */
  limits?: {
    maxConcurrent?: number;
    maxWaiting?: number;
    maxWaitMs?: number;
    maxPerRequester?: number;
    deadlineMs?: number;
    maxCachedBytes?: number;
  };
  /** Test seam for turning fetched bytes into an image; defaults to `linkPreviewImageDataUrl`. */
  decode?: (bytes: Uint8Array) => Promise<string | null>;
};

/**
 * Reads a link's page on the server so readers' devices never contact the linked site: its title,
 * description and site name from Open Graph, Twitter card or plain HTML tags, and its preview image
 * fetched and re-encoded as a small data URL. Every hop goes through the SSRF-checked fetch on the
 * default ports, no cookies or credentials are ever sent, and answers are cached per link, misses
 * included.
 */
export function createLinkPreviewResolver(
  options: LinkPreviewResolverOptions = {},
): LinkPreviewResolver {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? {};
  const cache = boundedCache<LinkPreview | null>({
    maxEntries: MAX_CACHED_LINKS,
    maxBytes: limits.maxCachedBytes ?? MAX_CACHED_BYTES,
    sizeOf: previewSize,
    now,
  });
  const inFlight = new Map<string, Promise<LinkPreviewAnswer>>();
  const perRequester = new Map<string, number>();
  const maxPerRequester = limits.maxPerRequester ?? MAX_PER_REQUESTER;
  const limit = concurrencyLimit(
    limits.maxConcurrent ?? MAX_CONCURRENT,
    limits.maxWaiting ?? MAX_WAITING,
    limits.maxWaitMs ?? MAX_WAIT_MS,
  );
  const deadlineMs = limits.deadlineMs ?? LOOKUP_DEADLINE_MS;

  return {
    async preview(input, requester) {
      const url = linkPreviewUrl(input);
      if (!url) return { preview: null };
      const cached = cache.get(url);
      if (cached) return { preview: cached.value };
      const pending = inFlight.get(url);
      if (pending) return pending;
      const held = requester === undefined ? 0 : (perRequester.get(requester) ?? 0);
      if (held >= maxPerRequester) return { preview: null, retry: true };
      if (requester !== undefined) perRequester.set(requester, held + 1);
      // A request turned away by a full queue is not a miss: it is not remembered, and the
      // answer tells the client to ask again later.
      const lookup = limit(() =>
        resolveLinkPreview(url, options, AbortSignal.timeout(deadlineMs)).catch(() => null),
      )
        .then((result): LinkPreviewAnswer => {
          if (result === BUSY) return { preview: null, retry: true };
          cache.set(url, result, result ? FOUND_TTL_MS : MISSING_TTL_MS);
          return { preview: result };
        })
        .finally(() => {
          inFlight.delete(url);
          if (requester === undefined) return;
          const left = (perRequester.get(requester) ?? 1) - 1;
          if (left > 0) perRequester.set(requester, left);
          else perRequester.delete(requester);
        });
      inFlight.set(url, lookup);
      return lookup;
    },
  };
}

function previewSize(preview: LinkPreview | null): number {
  if (!preview) return 0;
  return (
    preview.title.length +
    (preview.description?.length ?? 0) +
    (preview.siteName?.length ?? 0) +
    (preview.image?.length ?? 0)
  );
}

/**
 * The link a preview is read from, without its fragment, or undefined for anything that is not a
 * plain http(s) URL on its default port. Links that carry credentials are never fetched.
 */
export function linkPreviewUrl(input: string): string | undefined {
  if (input.length > LINK_PREVIEW_URL_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.port) return undefined;
  url.hash = "";
  return url.href.length <= LINK_PREVIEW_URL_MAX_LENGTH ? url.href : undefined;
}

async function resolveLinkPreview(
  url: string,
  options: LinkPreviewResolverOptions,
  signal: AbortSignal,
): Promise<LinkPreview | null> {
  const fetchOptions = {
    fetch: options.fetch,
    resolveHostname: options.resolveHostname,
    signal,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    allowedPorts: ALLOWED_PORTS,
  };
  const page = await fetchSafeWebBytes(url, {
    ...fetchOptions,
    maxBytes: PAGE_MAX_BYTES,
    truncate: true,
    headers: { accept: "text/html,application/xhtml+xml;q=0.9" },
  });
  if (!isHtml(page.contentType)) return null;
  const tags = linkPreviewTags(decodeHtml(page.body, page.contentType), page.url);
  if (!tags) return null;
  let image: string | null = null;
  if (tags.imageUrl && !signal.aborted) {
    const bytes = await fetchSafeWebBytes(tags.imageUrl, {
      ...fetchOptions,
      maxBytes: IMAGE_MAX_BYTES,
      headers: { accept: "image/png,image/jpeg,image/webp,image/gif;q=0.8" },
    }).catch(() => undefined);
    // Decoding counts against the same deadline as the fetches.
    if (bytes) {
      image = await untilAborted((options.decode ?? linkPreviewImageDataUrl)(bytes.body), signal);
    }
  }
  return {
    title: tags.title,
    description: tags.description,
    siteName: tags.siteName,
    image,
  };
}

/** A page with no declared type may still be HTML; anything declared as another type is not. */
function isHtml(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/** The page's text in its declared charset (the header, else a `<meta charset>`), UTF-8 otherwise. */
function decodeHtml(body: Uint8Array, contentType: string | null): string {
  const declared =
    /charset=["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(
      new TextDecoder("latin1").decode(body.subarray(0, 2048)),
    )?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

// Control and format characters (bidi overrides, zero-width joiners, the BOM) that a page could
// use to disguise its text, and the line breaks a one-line card should not keep.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.replace(HIDDEN_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length <= max
    ? text
    : `${characters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/** Card text and image address a page declares, or null when it names no title at all. */
export function linkPreviewTags(
  html: string,
  pageUrl: string,
): {
  title: string;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
} | null {
  // Card tags live in the head; parsing the body too would only cost time.
  const headEnd = html.search(/<\/head\s*>/i);
  const document = JSDOM.fragment(headEnd === -1 ? html : html.slice(0, headEnd));
  const meta = new Map<string, string>();
  for (const element of document.querySelectorAll("meta")) {
    const key = (element.getAttribute("property") ?? element.getAttribute("name"))
      ?.trim()
      .toLowerCase();
    const content = element.getAttribute("content")?.trim();
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => keys.map((key) => meta.get(key)).find(Boolean);
  const title = cleanText(
    first("og:title", "twitter:title") ?? document.querySelector("title")?.textContent,
    TITLE_MAX,
  );
  if (!title) return null;
  const image = first(
    "og:image:secure_url",
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  );
  return {
    title,
    description: cleanText(
      first("og:description", "twitter:description", "description"),
      DESCRIPTION_MAX,
    ),
    siteName: cleanText(first("og:site_name", "application-name"), SITE_NAME_MAX),
    imageUrl: image ? imageAddress(image, documentBase(document, pageUrl)) : null,
  };
}

function imageAddress(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href.length <= LINK_PREVIEW_URL_MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Turn fetched bytes into a data URL every client can draw: a landscape image at most 640 px wide,
 * as JPEG, or PNG when it has transparency and stays small enough. The bytes decide the format,
 * whatever type the server declared, so SVG and HTML never pass; large declared images are
 * refused before their pixels are decoded.
 */
export async function linkPreviewImageDataUrl(bytes: Uint8Array): Promise<string | null> {
  const format = sniffImage(bytes);
  if (!format || format === "ico") return null;
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const { width = 0, height = 0, hasAlpha, orientation = 1 } = await image.metadata();
    // EXIF orientations 5 to 8 turn the picture a quarter turn.
    const [shownWidth, shownHeight] = orientation >= 5 ? [height, width] : [width, height];
    if (shownWidth < MIN_IMAGE_WIDTH || shownWidth / Math.max(shownHeight, 1) < MIN_IMAGE_ASPECT) {
      return null;
    }
    const resized = () =>
      sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
        .rotate()
        .resize({ width: IMAGE_OUTPUT_WIDTH, withoutEnlargement: true });
    if (hasAlpha) {
      const png = await resized().png({ compressionLevel: 9 }).toBuffer();
      const url = `data:image/png;base64,${png.toString("base64")}`;
      if (url.length <= MAX_IMAGE_DATA_URL_LENGTH) return url;
    }
    // A photo saved with an unused alpha channel is still a photo: flatten it to JPEG.
    const jpeg = await resized()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 75 })
      .toBuffer();
    const url = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    return url.length <= MAX_IMAGE_DATA_URL_LENGTH ? url : null;
  } catch {
    // Truncated, corrupt or over the pixel limit.
    return null;
  }
}
