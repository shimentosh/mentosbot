/// <reference path="./linkify-it.d.ts" />

import type { LinkPreview, MessageBlock } from "@rakazo/contracts";
import { LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import { urlSite } from "@rakazo/core/egress";
import LinkifyIt from "linkify-it";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
  /** Draws a mention link from `withMentions`; returning nothing leaves its plain name. */
  renderMention?: (id: string, name: string) => ReactNode;
  /** Opens a page linked as `[title](page:<pageId>)`; without it the title stays plain text. */
  onOpenPage?: (pageId: string) => void;
};

const PAGE_URL_PATTERN = /^page:([A-Za-z0-9_-]{1,64})$/;

/** The page id of a `page:<pageId>` link, if this href is one. */
export function markdownPageId(href: string | undefined): string | undefined {
  return href ? PAGE_URL_PATTERN.exec(href)?.[1] : undefined;
}

const MENTION_URL_PREFIX = "rakazo-mention:";

/** The id of a mention link, if this href is one. */
export function markdownMentionId(href: string | undefined): string | undefined {
  if (!href?.startsWith(MENTION_URL_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(MENTION_URL_PREFIX.length)) || undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Code keeps its source exactly; existing links keep their text. A mention is never placed in them.
const CODE_MARKDOWN =
  "```[\\s\\S]*?(?:```|$)|~~~[\\s\\S]*?(?:~~~|$)|(?:^|\\n)(?: {4}|\\t)[^\\n]*|`[^`\\n]*`";
const CODE = new RegExp(`(${CODE_MARKDOWN})`);
const PROTECTED_MARKDOWN = new RegExp(`(${CODE_MARKDOWN}|!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\))`);
const MODEL_MENTION_LINK = /\[([^\]\n]*)\]\(\s*<?rakazo-mention:[^)\n]*\)/gi;
const OPENS_WITH_BLOCK = /^\s*(#|>|\||```|~~~|[-*+]\s|\d+[.)]\s)/;

function linkFirstName(text: string, name: string, link: string): string | undefined {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "u");
  let placed = false;
  const result = text
    .split(PROTECTED_MARKDOWN)
    .map((part, index) => {
      if (placed || index % 2 === 1) return part;
      return part.replace(pattern, (_match, prefix: string) => {
        placed = true;
        return `${prefix}${link}`;
      });
    })
    .join("");
  return placed ? result : undefined;
}

/**
 * Markdown texts of one message naming each entry once as a mention link: at its first
 * appearance across the texts, or at the start of the first text when none names it.
 */
export function withMentions(
  texts: readonly string[],
  mentions: readonly { id: string; name: string }[],
): string[] {
  // Only links placed here draw as mentions; ones already in the text keep just their name.
  const result = texts.map((text) =>
    text
      .split(CODE)
      .map((part, index) => (index % 2 === 1 ? part : part.replace(MODEL_MENTION_LINK, "$1")))
      .join(""),
  );
  if (result.length === 0) return result;
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;
    const link = `[${name.replace(/[\\[\]*_`<>]/g, "\\$&")}](${MENTION_URL_PREFIX}${encodeURIComponent(mention.id)})`;
    const placed = result.some((text, index) => {
      const linked = linkFirstName(text, name, link);
      if (linked !== undefined) result[index] = linked;
      return linked !== undefined;
    });
    if (placed) continue;
    const first = result[0]!;
    result[0] = OPENS_WITH_BLOCK.test(first) ? `${link}\n\n${first}` : `${link} ${first}`;
  }
  return result;
}

/** Message blocks whose prose names each entry once as a mention link. Tool activity is left alone. */
export function withBlockMentions(
  blocks: readonly MessageBlock[],
  mentions: readonly { id: string; name: string }[],
): MessageBlock[] {
  const prose = blocks.flatMap((block, index) =>
    block.kind === "text" || (block.kind === "progress" && !block.activity) ? [index] : [],
  );
  const texts = withMentions(
    prose.map((index) => (blocks[index] as { text: string }).text),
    mentions,
  );
  return blocks.map((block, index) => {
    const prosePosition = prose.indexOf(index);
    return prosePosition === -1
      ? block
      : ({ ...block, text: texts[prosePosition] } as MessageBlock);
  });
}

type LinkifyRules = {
  set(options: { fuzzyLink: boolean }): unknown;
  add(schema: string, definition: null): unknown;
};

type LinkifyParser = {
  set(options: { linkify: boolean }): unknown;
  linkify: LinkifyRules;
};

type ExplicitLinkMatch = {
  index: number;
  lastIndex: number;
  url: string;
};

type ExplicitLinkify = LinkifyRules & {
  match(text: string): ExplicitLinkMatch[] | null;
};

function applyExplicitLinkRules(linkify: LinkifyRules) {
  linkify.set({ fuzzyLink: false });
  linkify.add("ftp:", null);
  linkify.add("//", null);
}

/**
 * Turn bare http(s) URLs and email addresses into links, as the web renderer's GFM autolinks
 * do. Bare domains stay text: fuzzy matching would also link file names like setup.py or
 * notes.md. ftp: and protocol-relative URLs stay text because sanitizeMarkdownUrl would not
 * open them.
 */
export function linkifyExplicitUrls<T extends LinkifyParser>(parser: T): T {
  parser.set({ linkify: true });
  applyExplicitLinkRules(parser.linkify);
  return parser;
}

const plainTextLinkify: ExplicitLinkify = new LinkifyIt();
applyExplicitLinkRules(plainTextLinkify);

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export type PlainTextPart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string }
  | { type: "page"; value: string; pageId: string };

// The link pageReply puts before a sent reply: `[title](page:<pageId>)`, title brackets escaped.
const PLAIN_PAGE_LINK = /\[((?:\\[\\[\]]|[^\\[\]\n])*)\]\(page:([A-Za-z0-9_-]{1,64})\)/g;

function appendPlainText(parts: PlainTextPart[], value: string) {
  if (!value) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }
  parts.push({ type: "text", value });
}

/**
 * User bubbles stay plain text: markdown remains characters, except a page link, which opens the
 * page as it does in bot messages. Links use the bot messages' autolinker, so a balanced
 * parenthesis stays inside the URL and one wrapping the prose does not.
 */
export function plainTextLinkParts(text: string): PlainTextPart[] {
  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PLAIN_PAGE_LINK)) {
    if (match.index > cursor) parts.push(...urlLinkParts(text.slice(cursor, match.index)));
    const value = match[1]!.replace(/\\([\\[\]])/g, "$1");
    parts.push({ type: "page", value, pageId: match[2]! });
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return urlLinkParts(text);
  if (cursor < text.length) parts.push(...urlLinkParts(text.slice(cursor)));
  return parts;
}

function urlLinkParts(text: string): PlainTextPart[] {
  const matches = plainTextLinkify.match(text);
  if (!matches || matches.length === 0) return [{ type: "text", value: text }];

  const parts: PlainTextPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor || match.lastIndex <= match.index) continue;
    const value = text.slice(match.index, match.lastIndex);
    const href = sanitizeMarkdownUrl(match.url);
    appendPlainText(parts, text.slice(cursor, match.index));
    if (!href) {
      appendPlainText(parts, value);
      cursor = match.lastIndex;
      continue;
    }
    parts.push({ type: "link", value, href });
    cursor = match.lastIndex;
  }

  appendPlainText(parts, text.slice(cursor));
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#"))
  ) {
    return value;
  }
  return undefined;
}

const httpUrlProtocols = new Set(["http:", "https:"]);

function markdownLinkBase(appOrigin?: string | null) {
  if (!appOrigin) return "https://app.invalid";
  try {
    return new URL(appOrigin).origin;
  } catch {
    return "https://app.invalid";
  }
}

export function markdownLinkRequiresConfirmation(url: string, appOrigin?: string | null): boolean {
  const value = url.trim();
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, markdownLinkBase(appOrigin));
  } catch {
    return false;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return false;
  const explicitDestination = /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
  if (!explicitDestination) return false;
  if (!appOrigin) return true;
  try {
    return parsed.origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}

/**
 * The site "Always open" trusts for a link: its registrable domain, so every subdomain is
 * included, while each tenant of a shared host stays its own site. The server stores the same.
 */
export function markdownLinkSite(url: string): string | undefined {
  return urlSite(url);
}

/** Whether a link shows the external-link prompt: it leaves the app to a site not trusted. */
export function markdownLinkNeedsPrompt(
  url: string,
  appOrigin?: string | null,
  trustedSites: readonly string[] = [],
): boolean {
  if (!markdownLinkRequiresConfirmation(url, appOrigin)) return false;
  const site = markdownLinkSite(url);
  return !site || !trustedSites.includes(site);
}

export type MarkdownLinkDisplayParts = {
  before: string;
  host: string;
  after: string;
};

export function markdownLinkDisplayParts(url: string): MarkdownLinkDisplayParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!httpUrlProtocols.has(parsed.protocol)) return undefined;
  const href = parsed.href;
  const authorityAt = href.indexOf("//") + 2;
  const userinfoLength =
    parsed.username || parsed.password
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`.length
      : 0;
  const hostAt = authorityAt + userinfoLength;
  return {
    before: href.slice(0, hostAt),
    host: parsed.host,
    after: href.slice(hostAt + parsed.host.length),
  };
}

const imageLinkProtocols = new Set(["http", "https"]);

export function sanitizeMarkdownImageUrl(url: string): string | undefined {
  const href = sanitizeMarkdownUrl(url);
  if (!href) return undefined;
  const protocol = href.match(protocolPattern)?.[1]?.toLowerCase();
  return protocol && imageLinkProtocols.has(protocol) ? href : undefined;
}

const inlineImagePattern = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z\d+/=]+$/i;
const MAX_INLINE_IMAGE_URL_LENGTH = 1024 * 1024;

/**
 * Markdown images in bot output never fetch on their own: an image URL can carry conversation
 * data to any host the moment a reply renders. Only embedded raster data renders at once; a
 * remote image waits for the reader's tap unless they turned on loading web images.
 */
export function inlineMarkdownImageSrc(url: string): string | undefined {
  const value = url.trim();
  return value.length <= MAX_INLINE_IMAGE_URL_LENGTH && inlineImagePattern.test(value)
    ? value
    : undefined;
}

/** A markdown image that may load on request, with the host its placeholder names. */
export function remoteMarkdownImage(url: string): { href: string; host: string } | undefined {
  const href = sanitizeMarkdownImageUrl(url);
  if (!href) return undefined;
  try {
    return { href, host: new URL(href).host };
  } catch {
    return undefined;
  }
}

/** Whether remote markdown images load without a tap. Apps provide the reader's device setting. */
export const RemoteImagesContext = createContext(false);

// Images the reader chose to load stay loaded for the session, even after a bubble remounts.
const loadedRemoteImages = new Set<string>();

export function remoteImageLoaded(href: string): boolean {
  return loadedRemoteImages.has(href);
}

/** The current URL only. A link that cannot open stays text, so its image is not requested. */
export function remoteImageRenders(
  href: string,
  loadRemote: boolean,
  rejectedLink: boolean,
): boolean {
  return !rejectedLink && (loadRemote || remoteImageLoaded(href));
}

export function markRemoteImageLoaded(href: string): void {
  loadedRemoteImages.add(href);
}

const SHORT_LINK_LABEL_MAX = 40;
const SHORT_LINK_PATH_MIN = 12;
// Control and format characters (bidi overrides, zero-width joiners and spaces, the BOM) that a
// decoded path could use to disguise itself.
const HIDDEN_PATH_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

function httpUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodedUrl(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function comparableUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * The words a link shows. An author's label stays as written; a bare URL (an autolink, or a
 * label that just repeats the address) shortens to host and path, like `x.com/elonmusk`. The
 * host is what tells a reader where the link goes, so it is never cut and stays in its ASCII
 * (punycode) form; only a long path is trimmed.
 */
export function linkLabel(text: string, href: string): string {
  const url = httpUrl(href);
  // Some parsers show an autolink with its escapes decoded (`caf%C3%A9` as `café`), so a label
  // that matches the decoded address is bare too.
  const label = comparableUrl(text);
  if (!url || (label !== comparableUrl(href) && label !== comparableUrl(decodedUrl(href)))) {
    return text;
  }
  const host = url.host.replace(/^www\./i, "");
  const path = decodedUrl(url.pathname.replace(/\/+$/, "")).replace(HIDDEN_PATH_CHARACTERS, "");
  const room = Math.max(SHORT_LINK_LABEL_MAX - host.length, SHORT_LINK_PATH_MIN);
  if (path.length <= room) return `${host}${path}`;
  let end = room - 1;
  const before = path.charCodeAt(end - 1);
  const after = path.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return `${host}${path.slice(0, end)}…`;
}

/** The origin a link's site icon is looked up by, or undefined for links that get no icon. */
export function linkFaviconOrigin(href: string): string | undefined {
  return httpUrl(href)?.origin;
}

/**
 * Where link icons come from. Apps load them through the Rakazo API, which fetches and caches
 * them, so a device never contacts the linked site or an icon service. `globe` is the native
 * fallback glyph; web draws its own.
 */
export type LinkFavicons = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the site has no icon. */
  load(origin: string): Promise<{ icon: string | null; retry?: boolean }>;
  globe?: ReactNode;
};

export const LinkFaviconsContext = createContext<LinkFavicons | null>(null);

/** True while a reply streams: a half-written autolink host must not be looked up. */
export const LinkFaviconsPausedContext = createContext(false);

/** Where link previews come from: the Rakazo API, which reads and caches each linked page. */
export type LinkPreviews = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the page has no preview. */
  load(url: string): Promise<{ preview: LinkPreview | null; retry?: boolean }>;
};

export const LinkPreviewsContext = createContext<LinkPreviews | null>(null);

type LookupAnswer<T> = { value: T | null; retry?: boolean };

// A failed lookup (an older server without the procedure, or no connection) is not asked again
// by every link that mounts, but is retried after a while so a brief outage does not last all day.
const FAILED_LOOKUP_RETRY_MS = 5 * 60 * 1000;
// A busy server is asked again a few times, a little later, while the link stays on screen.
const BUSY_LOOKUP_RETRY_MS = 10_000;
const BUSY_LOOKUP_ATTEMPTS = 3;

/**
 * One answer per API endpoint and subject for the session, shared by every link on screen that
 * asks about the same subject: site icons by origin, previews by URL. Past `maxValues`, the oldest
 * answers no link on screen shows are forgotten, and asked for again if one comes back.
 */
function linkLookup<Source extends { endpoint?: string }, T>(
  ask: (source: Source, subject: string) => Promise<LookupAnswer<T>>,
  maxValues = Number.POSITIVE_INFINITY,
) {
  const values = new Map<string, T | null>();
  const pending = new Set<string>();
  const failed = new Map<string, number>();
  const busyRetries = new Map<string, ReturnType<typeof setTimeout>>();
  // How many links to each subject are on screen; a busy retry stops once none are.
  const mounted = new Map<string, number>();
  const listeners = new Set<() => void>();

  const setValue = (key: string, value: T | null) => {
    values.delete(key);
    values.set(key, value);
    for (const old of values.keys()) {
      if (values.size <= maxValues) break;
      if (!mounted.has(old)) values.delete(old);
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  // The subject stays pending across busy retries, so links that mount meanwhile do not ask too.
  const request = (source: Source, subject: string, key: string, attempt: number) => {
    pending.add(key);
    ask(source, subject).then(
      (answer) => {
        const shown = mounted.has(key);
        if (answer.retry && shown && attempt < BUSY_LOOKUP_ATTEMPTS) {
          const retry = () => {
            busyRetries.delete(key);
            request(source, subject, key, attempt + 1);
          };
          busyRetries.set(key, setTimeout(retry, BUSY_LOOKUP_RETRY_MS));
          return;
        }
        pending.delete(key);
        // A busy answer for links no longer on screen is dropped; the next one to mount asks.
        if (answer.retry && shown) failed.set(key, Date.now());
        else if (!answer.retry) setValue(key, answer.value);
      },
      () => {
        pending.delete(key);
        failed.set(key, Date.now());
      },
    );
  };

  /** The answer once the API has one, and a way to drop a value that turns out unusable. */
  return function useLookup(
    source: Source | null,
    subject: string | undefined,
    paused: boolean,
  ): { value: T | null; unusable: () => void } {
    const key = JSON.stringify([source?.endpoint ?? "", subject]);
    const snapshot = () => (subject ? (values.get(key) ?? null) : null);
    const value = useSyncExternalStore(subscribe, snapshot, snapshot);
    useEffect(() => {
      if (!subject) return;
      mounted.set(key, (mounted.get(key) ?? 0) + 1);
      return () => {
        const left = (mounted.get(key) ?? 1) - 1;
        if (left > 0) {
          mounted.set(key, left);
          return;
        }
        mounted.delete(key);
        const retry = busyRetries.get(key);
        if (retry === undefined) return;
        clearTimeout(retry);
        busyRetries.delete(key);
        pending.delete(key);
      };
    }, [key, subject]);
    useEffect(() => {
      if (!source || paused || !subject) return;
      if (values.has(key) || pending.has(key)) return;
      if (Date.now() - (failed.get(key) ?? -Infinity) < FAILED_LOOKUP_RETRY_MS) return;
      request(source, subject, key, 1);
    }, [source, paused, subject, key]);
    return {
      value,
      unusable: () => {
        if (subject) setValue(key, null);
      },
    };
  };
}

const useFaviconLookup = linkLookup<LinkFavicons, string>(async (source, origin) => {
  const answer = await source.load(origin);
  return { value: answer.icon, retry: answer.retry };
});

/** The icon for a link once the API has one, and a way to drop an image that turns out unusable. */
export function useLinkFavicon(href: string): { icon: string | null; unusable: () => void } {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const { value, unusable } = useFaviconLookup(source, linkFaviconOrigin(href), paused);
  return { icon: value, unusable };
}

// Previews carry an image each, so a long session keeps only the most recent ones.
const MAX_REMEMBERED_PREVIEWS = 200;

const usePreviewLookup = linkLookup<LinkPreviews, LinkPreview>(async (source, url) => {
  const answer = await source.load(url);
  return { value: answer.preview, retry: answer.retry };
}, MAX_REMEMBERED_PREVIEWS);

/** The preview for a link once the API has one; null while it loads and when there is none. */
export function useLinkPreview(url: string): LinkPreview | null {
  return usePreviewLookup(useContext(LinkPreviewsContext), url, false).value;
}

/** The site a card names: the page's own name for its site, else the link's host without www. */
export function linkPreviewSite(url: string, preview: Pick<LinkPreview, "siteName">): string {
  return preview.siteName ?? httpUrl(url)?.hostname.replace(/^www\./i, "") ?? url;
}

/** At most this many links in one message get a card, so a list of links stays a list. */
export const MAX_LINK_PREVIEWS = 2;

const LINKED_IMAGE = /\[!\[[^\]\n]*\]\([^)\n]*\)\]\([^)\n]*\)/g;
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const MARKDOWN_LINK = /\[((?:\\.|[^\\\]\n])*)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** A link a card may show: http(s), no credentials, short enough, not to the app itself. */
function previewableLink(href: string, appOrigin: string | null | undefined): string | undefined {
  const safe = sanitizeMarkdownUrl(href);
  const url = safe ? httpUrl(safe) : undefined;
  if (!url || url.username || url.password || url.href.length > LINK_PREVIEW_URL_MAX_LENGTH) {
    return undefined;
  }
  if (appOrigin) {
    try {
      if (url.origin === new URL(appOrigin).origin) return undefined;
    } catch {
      // An unreadable app origin matches nothing.
    }
  }
  return url.href;
}

/**
 * Links in markdown whose whole address the reader sees, in order: bare URLs, and links whose label
 * is the address itself. Other labelled links are blanked so their address is not found again.
 */
function visibleMarkdownLinks(prose: string): string[] {
  const found: { index: number; href: string }[] = [];
  const masked = prose.replace(
    MARKDOWN_LINK,
    (match: string, label: string, href: string, index: number) => {
      if (comparableUrl(label) === comparableUrl(href)) found.push({ index, href });
      return " ".repeat(match.length);
    },
  );
  for (const match of plainTextLinkify.match(masked) ?? []) {
    found.push({ index: match.index, href: match.url });
  }
  return found.sort((a, b) => a.index - b.index).map((link) => link.href);
}

/**
 * Links in a message that get a preview card, in order: only those whose full address the reader
 * sees, so a bare URL (in a sentence or alone) or a link labelled with its own address. A card makes
 * the server fetch the link before anyone taps it, so a link behind other words never gets one;
 * neither do images or anything in code. `plain` reads a user's literal text, where every explicit
 * URL is bare. Web and mobile both use this one rule.
 */
export function linkPreviewUrls(
  texts: readonly string[],
  options: { plain?: boolean; appOrigin?: string | null } = {},
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const add = (href: string) => {
    const link = previewableLink(href, options.appOrigin);
    const key = link?.replace(/#.*$/, "");
    if (!link || !key || seen.has(key) || links.length >= MAX_LINK_PREVIEWS) return;
    seen.add(key);
    links.push(link);
  };
  for (const text of texts) {
    if (options.plain) {
      for (const part of plainTextLinkParts(text)) if (part.type === "link") add(part.href);
      continue;
    }
    const prose = text
      .split(CODE)
      .filter((_, index) => index % 2 === 0)
      .join("\n")
      .replace(LINKED_IMAGE, " ")
      .replace(IMAGE, " ");
    for (const href of visibleMarkdownLinks(prose)) add(href);
  }
  return links;
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}

/**
 * A fence explicitly marked as plain text, such as a draft email: it wraps in the body font. Every
 * other fence, including one with no language, keeps the monospaced font and sideways scrolling.
 */
export function isProseFence(language: string): boolean {
  return ["text", "txt", "plaintext"].includes(language.toLowerCase());
}
