/// <reference path="./linkify-it.d.ts" />

import type { LinkPreview, MessageBlock } from "@rakazo/contracts";
import { comparableUrl, httpUrl, LINK_PREVIEW_URL_MAX_LENGTH } from "@rakazo/contracts";
import { urlSite } from "@rakazo/core/egress";
import LinkifyIt from "linkify-it";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
// Ends a mention the renderer put in front of text that doesn't name the bot. An encoded id
// never holds a `#`, so the mark can't be part of one.
const ADDED_MENTION_MARK = "#added";

/** Whether a mention link was put in front of the text, so its name isn't part of the message. */
export function markdownMentionAdded(href: string | undefined): boolean {
  return Boolean(href?.startsWith(MENTION_URL_PREFIX) && href.endsWith(ADDED_MENTION_MARK));
}

/** The id of a mention link, if this href is one. */
export function markdownMentionId(href: string | undefined): string | undefined {
  if (!href?.startsWith(MENTION_URL_PREFIX)) return undefined;
  const id = href.slice(MENTION_URL_PREFIX.length);
  try {
    return (
      decodeURIComponent(
        id.endsWith(ADDED_MENTION_MARK) ? id.slice(0, -ADDED_MENTION_MARK.length) : id,
      ) || undefined
    );
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const mentionParser = unified().use(remarkParse).use(remarkGfm);

type MentionTrees = Map<string, ReturnType<typeof mentionParser.parse> | null>;

function rewriteOutsideCode(
  text: string,
  rewrite: (part: string) => string,
  trees: MentionTrees,
  skipLinks = false,
) {
  if (trees.get(text) === null) return text;
  try {
    const tree = trees.get(text) ?? mentionParser.parse(text);
    trees.set(text, tree);
    let result = "";
    let offset = 0;
    function visit(node: typeof tree | (typeof tree.children)[number]) {
      if (
        node.type === "link" ||
        node.type === "code" ||
        node.type === "inlineCode" ||
        (skipLinks &&
          ["link", "image", "linkReference", "imageReference", "definition"].includes(node.type))
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          const source = text.slice(start, end);
          result +=
            rewrite(text.slice(offset, start)) +
            (!skipLinks &&
            node.type === "link" &&
            node.url.toLowerCase().startsWith(MENTION_URL_PREFIX)
              ? rewrite(source)
              : source);
          offset = end;
        }
        return;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    }
    visit(tree);
    return result + rewrite(text.slice(offset));
  } catch {
    trees.set(text, null);
    return text;
  }
}
const MODEL_MENTION_LINK = /\[([^\]\n]*)\]\(\s*<?rakazo-mention:[^)\n]*\)/gi;
const OPENS_WITH_BLOCK = /^\s*(#|>|\||```|~~~|[-*+]\s|\d+[.)]\s)/;

function linkFirstName(
  text: string,
  name: string,
  link: string,
  trees: MentionTrees,
): string | undefined {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "u");
  if (!pattern.test(text)) return undefined;
  let placed = false;
  const result = rewriteOutsideCode(
    text,
    (part) => {
      if (placed) return part;
      return part.replace(pattern, (_match, prefix: string) => {
        placed = true;
        return `${prefix}${link}`;
      });
    },
    trees,
    true,
  );
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
  const trees: MentionTrees = new Map();
  // Only links placed here draw as mentions; ones already in the text keep just their name.
  const result = texts.map((text) =>
    rewriteOutsideCode(text, (part) => part.replace(MODEL_MENTION_LINK, "$1"), trees),
  );
  if (result.length === 0) return result;
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;
    const link = `[${name.replace(/[\\[\]*_`<>]/g, "\\$&")}](${MENTION_URL_PREFIX}${encodeURIComponent(mention.id)})`;
    const placed = result.some((text, index) => {
      const linked = linkFirstName(text, name, link, trees);
      if (linked !== undefined) result[index] = linked;
      return linked !== undefined;
    });
    if (placed) continue;
    const firstIndex = result.findIndex((text) => trees.get(text) !== null);
    if (firstIndex === -1) continue;
    const first = result[firstIndex]!;
    const added = `${link.slice(0, -1)}${ADDED_MENTION_MARK})`;
    result[firstIndex] = OPENS_WITH_BLOCK.test(first)
      ? `${added}\n\n${first}`
      : `${added} ${first}`;
  }
  return result;
}

/**
 * Message blocks whose prose links each name where it first appears, as a mention link; a name
 * the prose does not use adds nothing. Tool activity, code and existing links are left alone.
 */
export function withBlockNameLinks(
  blocks: readonly MessageBlock[],
  names: readonly { id: string; name: string }[],
): MessageBlock[] {
  // Longer names first, so "Noor Social" is linked before a bot called "Noor" could take it.
  const ordered = [...names]
    .filter((entry) => entry.name.trim().length >= 3)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  if (!ordered.length) return [...blocks];
  const result = [...blocks];
  const trees: MentionTrees = new Map();
  for (const entry of ordered) {
    const name = entry.name.trim();
    const link = `[${name.replace(/[\\[\]*_`<>]/g, "\\$&")}](${MENTION_URL_PREFIX}${encodeURIComponent(entry.id)})`;
    for (let index = 0; index < result.length; index++) {
      const block = result[index]!;
      if (!(block.kind === "text" || (block.kind === "progress" && !block.activity))) continue;
      const linked = linkFirstName(block.text, name, link, trees);
      if (linked === undefined) continue;
      result[index] = { ...block, text: linked } as MessageBlock;
      break;
    }
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
// The bound fits any escaped title and keeps unclosed brackets from rescanning the message.
const PLAIN_PAGE_LINK = /\[((?:\\[\\[\]]|[^\\[\]\n]){0,400})\]\(page:([A-Za-z0-9_-]{1,64})\)/g;

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

  const keyFor = (source: Source | null, subject: string) =>
    JSON.stringify([source?.endpoint ?? "", subject]);
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
  /** Counts a link to this subject as on screen until the returned release runs. */
  const show = (key: string) => {
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
  };
  const askFor = (source: Source, subject: string, key: string) => {
    if (values.has(key) || pending.has(key)) return;
    if (Date.now() - (failed.get(key) ?? -Infinity) < FAILED_LOOKUP_RETRY_MS) return;
    request(source, subject, key, 1);
  };

  return {
    /** The answer once the API has one, and a way to drop a value that turns out unusable. */
    useOne(
      source: Source | null,
      subject: string | undefined,
      paused: boolean,
    ): { value: T | null; unusable: () => void } {
      const key = keyFor(source, subject ?? "");
      const snapshot = () => (subject ? (values.get(key) ?? null) : null);
      const value = useSyncExternalStore(subscribe, snapshot, snapshot);
      useEffect(() => (subject ? show(key) : undefined), [key, subject]);
      useEffect(() => {
        if (source && !paused && subject) askFor(source, subject, key);
      }, [source, paused, subject, key]);
      return {
        value,
        unusable: () => {
          if (subject) setValue(key, null);
        },
      };
    },
    /** The answers the API has for these subjects so far, by subject. */
    useMany(source: Source | null, subjects: readonly string[], paused: boolean) {
      const sorted = [...new Set(subjects)].sort();
      const subjectList = JSON.stringify(sorted);
      // The joined answers are a string, so an unchanged answer keeps the same snapshot.
      const snapshot = () =>
        JSON.stringify(sorted.map((subject) => values.get(keyFor(source, subject)) ?? null));
      const answers = useSyncExternalStore(subscribe, snapshot, snapshot);
      useEffect(() => {
        const shown: string[] = JSON.parse(subjectList);
        const releases = shown.map((subject) => show(keyFor(source, subject)));
        return () => {
          for (const release of releases) release();
        };
      }, [source, subjectList]);
      useEffect(() => {
        if (!source || paused) return;
        for (const subject of JSON.parse(subjectList) as string[]) {
          askFor(source, subject, keyFor(source, subject));
        }
      }, [source, paused, subjectList]);
      return useMemo(() => {
        const bySubject = new Map<string, T>();
        const list = JSON.parse(subjectList) as string[];
        (JSON.parse(answers) as (T | null)[]).forEach((answer, index) => {
          const subject = list[index];
          if (answer !== null && subject !== undefined) bySubject.set(subject, answer);
        });
        return bySubject as ReadonlyMap<string, T>;
      }, [answers, subjectList]);
    },
  };
}

const faviconLookup = linkLookup<LinkFavicons, string>(async (source, origin) => {
  const answer = await source.load(origin);
  return { value: answer.icon, retry: answer.retry };
});

/** The icon for a link once the API has one, and a way to drop an image that turns out unusable. */
export function useLinkFavicon(href: string): { icon: string | null; unusable: () => void } {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const { value, unusable } = faviconLookup.useOne(source, linkFaviconOrigin(href), paused);
  return { icon: value, unusable };
}

// Previews carry an image each, so a long session keeps only the most recent ones.
const MAX_REMEMBERED_PREVIEWS = 200;

const previewLookup = linkLookup<LinkPreviews, LinkPreview>(async (source, url) => {
  const answer = await source.load(url);
  return { value: answer.preview, retry: answer.retry };
}, MAX_REMEMBERED_PREVIEWS);

/** The preview for a link once the API has one; null while it loads and when there is none. */
export function useLinkPreview(url: string): LinkPreview | null {
  return previewLookup.useOne(useContext(LinkPreviewsContext), url, false).value;
}

/** The site a card names: the page's own name for its site, else the link's host without www. */
export function linkPreviewSite(url: string, preview: Pick<LinkPreview, "siteName">): string {
  return preview.siteName ?? httpUrl(url)?.hostname.replace(/^www\./i, "") ?? url;
}

/** At most this many links in one message get a card, so a list of links stays a list. */
export const MAX_LINK_PREVIEWS = 2;

// Fenced, indented and inline code, whose links are not the message's own.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|(?:^|\n)(?: {4}|\t)[^\n]*|`[^`\n]*`)/;
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

/** The icons the API has for these links so far, by link. */
export function useLinkFavicons(hrefs: readonly string[]): ReadonlyMap<string, string> {
  const source = useContext(LinkFaviconsContext);
  const paused = useContext(LinkFaviconsPausedContext);
  const origins = hrefs.flatMap((href) => linkFaviconOrigin(href) ?? []);
  const byOrigin = faviconLookup.useMany(source, origins, paused);
  return useMemo(() => {
    const byHref = new Map<string, string>();
    for (const href of hrefs) {
      const icon = byOrigin.get(linkFaviconOrigin(href) ?? "");
      if (icon) byHref.set(href, icon);
    }
    return byHref;
  }, [byOrigin, hrefs]);
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      if (marker === "`" && (match[2] ?? "").includes("`")) continue;
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
