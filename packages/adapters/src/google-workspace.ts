import { createHash, randomBytes } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/** Connection rows, secrets and tool routes for the user's own Google OAuth client. */
export const GOOGLE_WORKSPACE_CONNECTOR_ID = "google-workspace";
export const GOOGLE_WORKSPACE_CLIENT_KIND = "google-workspace-client";
export const GOOGLE_WORKSPACE_TOKEN_KIND = "google-workspace-token";
/** How long a started sign-in can be finished. */
export const GOOGLE_WORKSPACE_STATE_TTL_MS = 15 * 60 * 1000;

export const GOOGLE_WORKSPACE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
];

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh a little early so a call never starts with a token about to expire. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
/** Longest text a tool returns, so one big file cannot fill the model's context. */
const MAX_TEXT_CHARS = 100_000;

export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleTokens = {
  refreshToken: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  email: string;
};
type Fetch = typeof fetch;

export function newGoogleState(): { state: string; digest: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, digest: googleStateDigest(state) };
}

export function googleStateDigest(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

export function googleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
    access_type: "offline",
    // Always ask again so Google returns a refresh token, even for an account it has seen.
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  }).toString();
  return url.toString();
}

async function oauthRequest(
  fetchImpl: Fetch,
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const reason =
      typeof data.error_description === "string"
        ? data.error_description
        : typeof data.error === "string"
          ? data.error
          : `HTTP ${response.status}`;
    throw new GoogleAuthError(reason, data.error === "invalid_grant");
  }
  return data;
}

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** The refresh token or code is no longer valid; the user must connect again. */
    readonly revoked = false,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** Trade the sign-in code for tokens and the account's email. */
export async function exchangeGoogleCode(
  input: { client: GoogleClient; code: string; redirectUri: string },
  fetchImpl: Fetch = fetch,
): Promise<GoogleTokens> {
  const data = await oauthRequest(fetchImpl, TOKEN_URL, {
    code: input.code,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new GoogleAuthError("Google did not return an offline token. Try connecting again.");
  }
  const userinfo = await fetchImpl(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const profile = (await userinfo.json().catch(() => ({}))) as { email?: unknown };
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    email: typeof profile.email === "string" ? profile.email : "Google account",
  };
}

export async function refreshGoogleToken(
  client: GoogleClient,
  refreshToken: string,
  fetchImpl: Fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const data = await oauthRequest(fetchImpl, TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (typeof data.access_token !== "string") {
    throw new GoogleAuthError("Google did not return an access token.");
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
}

/** Best effort: the local copy is deleted whether or not Google answers. */
export async function revokeGoogleToken(token: string, fetchImpl: Fetch = fetch): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

export function parseGoogleClient(plaintext: string): GoogleClient {
  const parsed = JSON.parse(plaintext) as Partial<GoogleClient>;
  if (typeof parsed.clientId !== "string" || typeof parsed.clientSecret !== "string") {
    throw new Error("Stored Google client is malformed");
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

export function parseGoogleTokens(plaintext: string): GoogleTokens {
  const parsed = JSON.parse(plaintext) as Partial<GoogleTokens>;
  if (typeof parsed.refreshToken !== "string") throw new Error("Stored Google token is malformed");
  return {
    refreshToken: parsed.refreshToken,
    accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
    email: typeof parsed.email === "string" ? parsed.email : "",
  };
}

/** The newest client the user saved, or null. */
export async function loadGoogleClient(
  prisma: PrismaClient,
  secrets: SecretStore,
  userId: string,
): Promise<{ id: string; client: GoogleClient } | null> {
  const secret = await prisma.secret.findFirst({
    where: { userId, kind: GOOGLE_WORKSPACE_CLIENT_KIND },
    orderBy: { createdAt: "desc" },
  });
  if (!secret) return null;
  const plaintext = await secrets.load(secret.ciphertext, { recordId: secret.id });
  return { id: secret.id, client: parseGoogleClient(plaintext) };
}

// ---------------------------------------------------------------------------
// Tools

type Args = Record<string, unknown>;
type Api = (
  method: string,
  url: string,
  options?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    raw?: { contentType: string; data: string };
    text?: boolean;
  },
) => Promise<unknown>;

type ToolSpec = {
  name: string;
  description: string;
  readOnly: boolean;
  properties: Record<string, unknown>;
  required?: string[];
  run: (api: Api, args: Args) => Promise<unknown>;
};

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS = "https://docs.googleapis.com/v1/documents";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const DRIVE_FILE_FIELDS =
  "id,name,mimeType,modifiedTime,size,webViewLink,parents,owners(emailAddress)";

const GOOGLE_TYPES: Record<string, string> = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
};

function str(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function need(args: Args, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function strings(args: Args, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a list of strings`);
  }
  return value as string[];
}

function count(args: Args, key: string, fallback: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${key} must be a positive number`);
  return Math.min(Math.floor(n), max);
}

function rows(args: Args, key: string): unknown[][] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((row) => !Array.isArray(row))) {
    throw new Error(`${key} must be a list of rows, each a list of cell values`);
  }
  return value as unknown[][];
}

function clip(text: string): { text: string; truncated?: true } {
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** RFC 2047 so non-ASCII subjects and names survive the trip. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailPart[];
};

function gmailBody(part: GmailPart): { plain: string; html: string; attachments: unknown[] } {
  const found = { plain: "", html: "", attachments: [] as unknown[] };
  const walk = (node: GmailPart) => {
    if (node.filename && node.body?.attachmentId) {
      found.attachments.push({
        filename: node.filename,
        mimeType: node.mimeType,
        size: node.body.size,
      });
    } else if (node.body?.data) {
      if (node.mimeType === "text/plain" && !found.plain)
        found.plain = decodeBase64url(node.body.data);
      if (node.mimeType === "text/html" && !found.html)
        found.html = decodeBase64url(node.body.data);
    }
    for (const child of node.parts ?? []) walk(child);
  };
  walk(part);
  return found;
}

function headerMap(part: GmailPart | undefined, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of part?.headers ?? []) {
    const name = names.find((wanted) => wanted.toLowerCase() === header.name.toLowerCase());
    if (name) out[name.toLowerCase()] = header.value;
  }
  return out;
}

async function buildRawEmail(api: Api, args: Args): Promise<{ raw: string; threadId?: string }> {
  let to = strings(args, "to");
  let subject = str(args, "subject") ?? "";
  const extra: string[] = [];
  let threadId: string | undefined;
  const replyTo = str(args, "replyToMessageId");
  if (replyTo) {
    const original = (await api("GET", `${GMAIL}/messages/${encodeURIComponent(replyTo)}`, {
      query: { format: "metadata" },
    })) as { threadId?: string; payload?: GmailPart };
    const headers = headerMap(original.payload, [
      "Message-ID",
      "Subject",
      "From",
      "Reply-To",
      "References",
    ]);
    threadId = original.threadId;
    if (to.length === 0) to = [headers["reply-to"] ?? headers.from ?? ""].filter(Boolean);
    if (!subject) {
      const base = headers.subject ?? "";
      subject = /^re:/i.test(base) ? base : `Re: ${base}`;
    }
    if (headers["message-id"]) {
      extra.push(`In-Reply-To: ${headers["message-id"]}`);
      extra.push(
        `References: ${[headers.references, headers["message-id"]].filter(Boolean).join(" ")}`,
      );
    }
  }
  if (to.length === 0) throw new Error("to is required");
  const body = need(args, "body");
  const html = args.html === true;
  const lines = [
    `To: ${to.join(", ")}`,
    ...(strings(args, "cc").length ? [`Cc: ${strings(args, "cc").join(", ")}`] : []),
    ...(strings(args, "bcc").length ? [`Bcc: ${strings(args, "bcc").join(", ")}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...extra,
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body).toString("base64"),
  ];
  return { raw: base64url(lines.join("\r\n")), threadId };
}

function docText(document: { body?: { content?: unknown[] } }): string {
  let text = "";
  const walk = (elements: unknown[] | undefined) => {
    for (const element of elements ?? []) {
      const node = element as {
        paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
        table?: { tableRows?: Array<{ tableCells?: Array<{ content?: unknown[] }> }> };
        tableOfContents?: { content?: unknown[] };
      };
      for (const run of node.paragraph?.elements ?? []) text += run.textRun?.content ?? "";
      for (const row of node.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          walk(cell.content);
          text += "\t";
        }
        text += "\n";
      }
      walk(node.tableOfContents?.content);
    }
  };
  walk(document.body?.content);
  return text;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql))/;

function eventTime(value: string | undefined, timeZone: string | undefined) {
  if (!value) return undefined;
  // A bare date is an all-day event.
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { date: value }
    : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function eventBody(args: Args) {
  const timeZone = str(args, "timeZone");
  const attendees = strings(args, "attendees");
  const body: Record<string, unknown> = {
    summary: str(args, "summary"),
    description: str(args, "description"),
    location: str(args, "location"),
    start: eventTime(str(args, "start"), timeZone),
    end: eventTime(str(args, "end"), timeZone),
    ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
  };
  if (args.meet === true) {
    body.conferenceData = {
      createRequest: { requestId: randomBytes(8).toString("hex") },
    };
  }
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return body;
}

function googleApiUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/(^|\.)googleapis\.com$/.test(url.hostname)) {
    throw new Error("url must be an https://…googleapis.com address");
  }
  return url.toString();
}

const range = { type: "string", description: "A1 range such as Sheet1!A1:D20" };
const values = {
  type: "array",
  description: "Rows of cell values; strings starting with = are formulas",
  items: { type: "array", items: {} },
};
const emailList = { type: "array", items: { type: "string" } };

export const GOOGLE_WORKSPACE_TOOLS: ToolSpec[] = [
  {
    name: "gmail_search",
    description:
      "Search the connected Gmail with Gmail search syntax (from:, to:, subject:, is:unread, newer_than:7d, label:). Returns sender, subject, date and snippet.",
    readOnly: true,
    properties: {
      query: { type: "string" },
      maxResults: { type: "integer", minimum: 1, maximum: 50 },
    },
    async run(api, args) {
      const list = (await api("GET", `${GMAIL}/messages`, {
        query: { q: str(args, "query"), maxResults: count(args, "maxResults", 10, 50) },
      })) as { messages?: Array<{ id: string; threadId: string }> };
      const messages = await Promise.all(
        (list.messages ?? []).map(async ({ id }) => {
          const message = (await api("GET", `${GMAIL}/messages/${id}`, {
            query: { format: "metadata" },
          })) as {
            id: string;
            threadId: string;
            snippet?: string;
            labelIds?: string[];
            payload?: GmailPart;
          };
          return {
            id: message.id,
            threadId: message.threadId,
            ...headerMap(message.payload, ["From", "To", "Subject", "Date"]),
            snippet: message.snippet,
            unread: message.labelIds?.includes("UNREAD") ?? false,
          };
        }),
      );
      return { messages };
    },
  },
  {
    name: "gmail_read",
    description: "Read one Gmail message: headers, text body and attachment names.",
    readOnly: true,
    properties: { messageId: { type: "string" } },
    required: ["messageId"],
    async run(api, args) {
      const message = (await api(
        "GET",
        `${GMAIL}/messages/${encodeURIComponent(need(args, "messageId"))}`,
        { query: { format: "full" } },
      )) as { id: string; threadId: string; labelIds?: string[]; payload?: GmailPart };
      const body = message.payload ? gmailBody(message.payload) : undefined;
      return {
        id: message.id,
        threadId: message.threadId,
        labels: message.labelIds,
        ...headerMap(message.payload, ["From", "To", "Cc", "Subject", "Date"]),
        body: clip(body?.plain || htmlToText(body?.html ?? "")).text,
        attachments: body?.attachments ?? [],
      };
    },
  },
  {
    name: "gmail_send",
    description:
      "Send an email from the connected Gmail. Pass replyToMessageId to reply in that thread; to and subject then default to the original.",
    readOnly: false,
    properties: {
      to: emailList,
      cc: emailList,
      bcc: emailList,
      subject: { type: "string" },
      body: { type: "string" },
      html: { type: "boolean", description: "The body is HTML" },
      replyToMessageId: { type: "string" },
    },
    required: ["body"],
    async run(api, args) {
      const { raw, threadId } = await buildRawEmail(api, args);
      return api("POST", `${GMAIL}/messages/send`, { body: { raw, threadId } });
    },
  },
  {
    name: "gmail_create_draft",
    description: "Save an email as a Gmail draft without sending it. Same fields as gmail_send.",
    readOnly: false,
    properties: {
      to: emailList,
      cc: emailList,
      bcc: emailList,
      subject: { type: "string" },
      body: { type: "string" },
      html: { type: "boolean" },
      replyToMessageId: { type: "string" },
    },
    required: ["body"],
    async run(api, args) {
      const { raw, threadId } = await buildRawEmail(api, args);
      return api("POST", `${GMAIL}/drafts`, { body: { message: { raw, threadId } } });
    },
  },
  {
    name: "gmail_modify_labels",
    description:
      "Add or remove labels on Gmail messages. Remove UNREAD to mark read, INBOX to archive; add TRASH to move to trash, STARRED to star.",
    readOnly: false,
    properties: {
      messageIds: emailList,
      addLabels: emailList,
      removeLabels: emailList,
    },
    required: ["messageIds"],
    async run(api, args) {
      const ids = strings(args, "messageIds");
      if (ids.length === 0) throw new Error("messageIds is required");
      await api("POST", `${GMAIL}/messages/batchModify`, {
        body: {
          ids,
          addLabelIds: strings(args, "addLabels"),
          removeLabelIds: strings(args, "removeLabels"),
        },
      });
      return { ok: true, modified: ids.length };
    },
  },
  {
    name: "drive_search",
    description:
      "Find files in Google Drive. query uses Drive search syntax, e.g. name contains 'report' and mimeType = 'application/vnd.google-apps.spreadsheet'. Omit it for recent files.",
    readOnly: true,
    properties: {
      query: { type: "string" },
      folderId: { type: "string", description: "Only files directly in this folder" },
      maxResults: { type: "integer", minimum: 1, maximum: 100 },
    },
    async run(api, args) {
      const clauses = ["trashed = false"];
      const query = str(args, "query");
      const folderId = str(args, "folderId");
      if (query) clauses.push(`(${query})`);
      if (folderId) clauses.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
      return api("GET", `${DRIVE}/files`, {
        query: {
          q: clauses.join(" and "),
          pageSize: count(args, "maxResults", 20, 100),
          orderBy: query ? undefined : "modifiedTime desc",
          fields: `files(${DRIVE_FILE_FIELDS})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
    },
  },
  {
    name: "drive_read",
    description:
      "Read a Drive file as text. Docs and Slides come back as plain text, Sheets as CSV of the first sheet (use sheets_read for others), text files as is.",
    readOnly: true,
    properties: { fileId: { type: "string" } },
    required: ["fileId"],
    async run(api, args) {
      const fileId = encodeURIComponent(need(args, "fileId"));
      const file = (await api("GET", `${DRIVE}/files/${fileId}`, {
        query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
      })) as { mimeType?: string; name?: string; size?: string };
      const exportAs: Record<string, string> = {
        [GOOGLE_TYPES.document!]: "text/plain",
        [GOOGLE_TYPES.presentation!]: "text/plain",
        [GOOGLE_TYPES.spreadsheet!]: "text/csv",
      };
      const mimeType = file.mimeType ?? "";
      if (exportAs[mimeType]) {
        const text = (await api("GET", `${DRIVE}/files/${fileId}/export`, {
          query: { mimeType: exportAs[mimeType] },
          text: true,
        })) as string;
        return { file, ...clip(text) };
      }
      if (TEXT_TYPES.test(mimeType)) {
        const text = (await api("GET", `${DRIVE}/files/${fileId}`, {
          query: { alt: "media", supportsAllDrives: true },
          text: true,
        })) as string;
        return { file, ...clip(text) };
      }
      return { file, note: "This file type cannot be read as text; share its link instead." };
    },
  },
  {
    name: "drive_create_file",
    description:
      "Create a Drive file from text. Set convertTo to document or spreadsheet to make a Google Doc (from text or HTML) or Sheet (from CSV); folder makes a folder and ignores content.",
    readOnly: false,
    properties: {
      name: { type: "string" },
      content: { type: "string" },
      contentType: {
        type: "string",
        description:
          "MIME type of content: text/plain (default), text/csv, text/html, application/json…",
      },
      convertTo: { type: "string", enum: ["document", "spreadsheet", "presentation", "folder"] },
      folderId: { type: "string" },
    },
    required: ["name"],
    async run(api, args) {
      const convertTo = str(args, "convertTo");
      const metadata = {
        name: need(args, "name"),
        ...(str(args, "folderId") ? { parents: [str(args, "folderId")] } : {}),
        ...(convertTo ? { mimeType: GOOGLE_TYPES[convertTo] } : {}),
      };
      const content = str(args, "content");
      if (convertTo === "folder" || content === undefined) {
        return api("POST", `${DRIVE}/files`, {
          query: { fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
          body: metadata,
        });
      }
      const boundary = `rakazo-${randomBytes(8).toString("hex")}`;
      const contentType =
        str(args, "contentType") ?? (convertTo === "spreadsheet" ? "text/csv" : "text/plain");
      const data = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${contentType}; charset=UTF-8`,
        "",
        content,
        `--${boundary}--`,
      ].join("\r\n");
      return api("POST", `${DRIVE_UPLOAD}/files`, {
        query: { uploadType: "multipart", fields: DRIVE_FILE_FIELDS, supportsAllDrives: true },
        raw: { contentType: `multipart/related; boundary=${boundary}`, data },
      });
    },
  },
  {
    name: "drive_update_file",
    description:
      "Rename, move, trash or restore a Drive file, or replace a plain file's text content.",
    readOnly: false,
    properties: {
      fileId: { type: "string" },
      name: { type: "string" },
      moveToFolderId: { type: "string" },
      trashed: { type: "boolean" },
      content: { type: "string", description: "New content for a non-Google file" },
      contentType: { type: "string" },
    },
    required: ["fileId"],
    async run(api, args) {
      const fileId = encodeURIComponent(need(args, "fileId"));
      const content = str(args, "content");
      if (content !== undefined) {
        await api("PATCH", `${DRIVE_UPLOAD}/files/${fileId}`, {
          query: { uploadType: "media", supportsAllDrives: true },
          raw: { contentType: str(args, "contentType") ?? "text/plain", data: content },
        });
      }
      const moveTo = str(args, "moveToFolderId");
      let removeParents: string | undefined;
      if (moveTo) {
        const current = (await api("GET", `${DRIVE}/files/${fileId}`, {
          query: { fields: "parents", supportsAllDrives: true },
        })) as { parents?: string[] };
        removeParents = current.parents?.join(",");
      }
      const patch: Record<string, unknown> = {};
      if (str(args, "name")) patch.name = str(args, "name");
      if (typeof args.trashed === "boolean") patch.trashed = args.trashed;
      return api("PATCH", `${DRIVE}/files/${fileId}`, {
        query: {
          fields: DRIVE_FILE_FIELDS,
          supportsAllDrives: true,
          addParents: moveTo,
          removeParents,
        },
        body: patch,
      });
    },
  },
  {
    name: "drive_share",
    description:
      "Share a Drive file with someone by email, or with anyone who has the link when email is omitted.",
    readOnly: false,
    properties: {
      fileId: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ["reader", "commenter", "writer"] },
      notify: { type: "boolean", description: "Email the person (default true)" },
    },
    required: ["fileId"],
    async run(api, args) {
      const email = str(args, "email");
      await api("POST", `${DRIVE}/files/${encodeURIComponent(need(args, "fileId"))}/permissions`, {
        query: {
          supportsAllDrives: true,
          sendNotificationEmail: email ? args.notify !== false : undefined,
        },
        body: email
          ? { type: "user", emailAddress: email, role: str(args, "role") ?? "reader" }
          : { type: "anyone", role: str(args, "role") ?? "reader" },
      });
      return api("GET", `${DRIVE}/files/${encodeURIComponent(need(args, "fileId"))}`, {
        query: { fields: "id,name,webViewLink", supportsAllDrives: true },
      });
    },
  },
  {
    name: "sheets_get",
    description: "List a spreadsheet's title, URL and tabs with their sizes.",
    readOnly: true,
    properties: { spreadsheetId: { type: "string" } },
    required: ["spreadsheetId"],
    async run(api, args) {
      return api("GET", `${SHEETS}/${encodeURIComponent(need(args, "spreadsheetId"))}`, {
        query: {
          fields:
            "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))",
        },
      });
    },
  },
  {
    name: "sheets_read",
    description: "Read cell values from a Google Sheet range.",
    readOnly: true,
    properties: { spreadsheetId: { type: "string" }, range },
    required: ["spreadsheetId", "range"],
    async run(api, args) {
      return api(
        "GET",
        `${SHEETS}/${encodeURIComponent(need(args, "spreadsheetId"))}/values/${encodeURIComponent(need(args, "range"))}`,
      );
    },
  },
  {
    name: "sheets_write",
    description:
      "Write to a Google Sheet. mode overwrite (default) sets the range, append adds rows after the table in the range, clear empties the range.",
    readOnly: false,
    properties: {
      spreadsheetId: { type: "string" },
      range,
      values,
      mode: { type: "string", enum: ["overwrite", "append", "clear"] },
    },
    required: ["spreadsheetId", "range"],
    async run(api, args) {
      const base = `${SHEETS}/${encodeURIComponent(need(args, "spreadsheetId"))}/values/${encodeURIComponent(need(args, "range"))}`;
      const mode = str(args, "mode") ?? "overwrite";
      if (mode === "clear") return api("POST", `${base}:clear`, { body: {} });
      const body = { values: rows(args, "values") };
      if (mode === "append") {
        return api("POST", `${base}:append`, {
          query: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
          body,
        });
      }
      return api("PUT", base, { query: { valueInputOption: "USER_ENTERED" }, body });
    },
  },
  {
    name: "sheets_create",
    description:
      "Create a Google Sheet, optionally with named tabs and starting rows in the first tab.",
    readOnly: false,
    properties: {
      title: { type: "string" },
      tabs: emailList,
      values,
    },
    required: ["title"],
    async run(api, args) {
      const tabs = strings(args, "tabs");
      const created = (await api("POST", SHEETS, {
        body: {
          properties: { title: need(args, "title") },
          ...(tabs.length ? { sheets: tabs.map((title) => ({ properties: { title } })) } : {}),
        },
      })) as {
        spreadsheetId: string;
        spreadsheetUrl: string;
        sheets?: Array<{ properties?: { title?: string } }>;
      };
      if (Array.isArray(args.values) && args.values.length > 0) {
        const tab = created.sheets?.[0]?.properties?.title ?? "Sheet1";
        await api(
          "PUT",
          `${SHEETS}/${created.spreadsheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}`,
          { query: { valueInputOption: "USER_ENTERED" }, body: { values: rows(args, "values") } },
        );
      }
      return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl };
    },
  },
  {
    name: "sheets_batch_update",
    description:
      "Run Sheets API batchUpdate requests for anything else: formatting, adding or deleting tabs, sorting, charts, merges, conditional formats.",
    readOnly: false,
    properties: {
      spreadsheetId: { type: "string" },
      requests: { type: "array", items: { type: "object" } },
    },
    required: ["spreadsheetId", "requests"],
    async run(api, args) {
      return api(
        "POST",
        `${SHEETS}/${encodeURIComponent(need(args, "spreadsheetId"))}:batchUpdate`,
        {
          body: { requests: args.requests },
        },
      );
    },
  },
  {
    name: "docs_read",
    description: "Read a Google Doc's title and text.",
    readOnly: true,
    properties: { documentId: { type: "string" } },
    required: ["documentId"],
    async run(api, args) {
      const document = (await api(
        "GET",
        `${DOCS}/${encodeURIComponent(need(args, "documentId"))}`,
      )) as {
        documentId: string;
        title?: string;
        body?: { content?: unknown[] };
      };
      return { documentId: document.documentId, title: document.title, ...clip(docText(document)) };
    },
  },
  {
    name: "docs_create",
    description: "Create a Google Doc, optionally with starting text.",
    readOnly: false,
    properties: { title: { type: "string" }, text: { type: "string" } },
    required: ["title"],
    async run(api, args) {
      const created = (await api("POST", DOCS, { body: { title: need(args, "title") } })) as {
        documentId: string;
      };
      const text = str(args, "text");
      if (text) {
        await api("POST", `${DOCS}/${created.documentId}:batchUpdate`, {
          body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
        });
      }
      return {
        documentId: created.documentId,
        url: `https://docs.google.com/document/d/${created.documentId}/edit`,
      };
    },
  },
  {
    name: "docs_write",
    description:
      "Edit a Google Doc's text: append adds text at the end; replace swaps every match of find with text.",
    readOnly: false,
    properties: {
      documentId: { type: "string" },
      mode: { type: "string", enum: ["append", "replace"] },
      text: { type: "string" },
      find: { type: "string" },
      matchCase: { type: "boolean" },
    },
    required: ["documentId", "mode", "text"],
    async run(api, args) {
      const documentId = encodeURIComponent(need(args, "documentId"));
      const text = typeof args.text === "string" ? args.text : need(args, "text");
      const request =
        str(args, "mode") === "replace"
          ? {
              replaceAllText: {
                containsText: { text: need(args, "find"), matchCase: args.matchCase === true },
                replaceText: text,
              },
            }
          : { insertText: { endOfSegmentLocation: {}, text } };
      return api("POST", `${DOCS}/${documentId}:batchUpdate`, { body: { requests: [request] } });
    },
  },
  {
    name: "docs_batch_update",
    description:
      "Run Docs API batchUpdate requests for anything else: styles, headings, tables, images, inserting at an index.",
    readOnly: false,
    properties: {
      documentId: { type: "string" },
      requests: { type: "array", items: { type: "object" } },
    },
    required: ["documentId", "requests"],
    async run(api, args) {
      return api("POST", `${DOCS}/${encodeURIComponent(need(args, "documentId"))}:batchUpdate`, {
        body: { requests: args.requests },
      });
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List Google Calendar events between timeMin and timeMax (RFC 3339), soonest first. Use calendarId from calendar_list_calendars; primary by default.",
    readOnly: true,
    properties: {
      calendarId: { type: "string" },
      timeMin: { type: "string" },
      timeMax: { type: "string" },
      query: { type: "string" },
      maxResults: { type: "integer", minimum: 1, maximum: 250 },
    },
    async run(api, args) {
      const calendarId = encodeURIComponent(str(args, "calendarId") ?? "primary");
      return api("GET", `${CALENDAR}/calendars/${calendarId}/events`, {
        query: {
          singleEvents: true,
          orderBy: "startTime",
          timeMin: str(args, "timeMin") ?? new Date().toISOString(),
          timeMax: str(args, "timeMax"),
          q: str(args, "query"),
          maxResults: count(args, "maxResults", 25, 250),
          fields:
            "items(id,summary,description,location,start,end,attendees(email,responseStatus),hangoutLink,htmlLink,status)",
        },
      });
    },
  },
  {
    name: "calendar_list_calendars",
    description: "List the calendars the connected account can see.",
    readOnly: true,
    properties: {},
    async run(api) {
      return api("GET", `${CALENDAR}/users/me/calendarList`, {
        query: { fields: "items(id,summary,primary,accessRole,timeZone)" },
      });
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Create a Google Calendar event. start and end are RFC 3339 times, or YYYY-MM-DD for all-day. meet adds a Google Meet link.",
    readOnly: false,
    properties: {
      calendarId: { type: "string" },
      summary: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      timeZone: { type: "string", description: "IANA zone, e.g. Asia/Dhaka" },
      description: { type: "string" },
      location: { type: "string" },
      attendees: emailList,
      meet: { type: "boolean" },
      notify: { type: "boolean", description: "Email invitations to attendees (default true)" },
    },
    required: ["summary", "start", "end"],
    async run(api, args) {
      const calendarId = encodeURIComponent(str(args, "calendarId") ?? "primary");
      return api("POST", `${CALENDAR}/calendars/${calendarId}/events`, {
        query: {
          conferenceDataVersion: args.meet === true ? 1 : undefined,
          sendUpdates: args.notify === false ? "none" : "all",
        },
        body: eventBody(args),
      });
    },
  },
  {
    name: "calendar_update_event",
    description:
      "Change a Google Calendar event. Only the fields given change; attendees replaces the list.",
    readOnly: false,
    properties: {
      calendarId: { type: "string" },
      eventId: { type: "string" },
      summary: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      timeZone: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      attendees: emailList,
      notify: { type: "boolean" },
    },
    required: ["eventId"],
    async run(api, args) {
      const calendarId = encodeURIComponent(str(args, "calendarId") ?? "primary");
      return api(
        "PATCH",
        `${CALENDAR}/calendars/${calendarId}/events/${encodeURIComponent(need(args, "eventId"))}`,
        { query: { sendUpdates: args.notify === false ? "none" : "all" }, body: eventBody(args) },
      );
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a Google Calendar event.",
    readOnly: false,
    properties: {
      calendarId: { type: "string" },
      eventId: { type: "string" },
      notify: { type: "boolean" },
    },
    required: ["eventId"],
    async run(api, args) {
      const calendarId = encodeURIComponent(str(args, "calendarId") ?? "primary");
      await api(
        "DELETE",
        `${CALENDAR}/calendars/${calendarId}/events/${encodeURIComponent(need(args, "eventId"))}`,
        { query: { sendUpdates: args.notify === false ? "none" : "all" } },
      );
      return { ok: true };
    },
  },
  {
    name: "google_api_get",
    description:
      "Read from any Google API the account allows (Slides, Tasks, Gmail settings, Drive revisions…) with an https://…googleapis.com URL.",
    readOnly: true,
    properties: {
      url: { type: "string" },
      query: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["url"],
    async run(api, args) {
      return api("GET", googleApiUrl(need(args, "url")), {
        query: (args.query as Record<string, string> | undefined) ?? undefined,
      });
    },
  },
  {
    name: "google_api_request",
    description:
      "Change anything through a Google API the other tools do not cover, with an https://…googleapis.com URL and JSON body.",
    readOnly: false,
    properties: {
      method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
      url: { type: "string" },
      query: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "object" },
    },
    required: ["method", "url"],
    async run(api, args) {
      const method = need(args, "method").toUpperCase();
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new Error("method must be POST, PUT, PATCH or DELETE");
      }
      return api(method, googleApiUrl(need(args, "url")), {
        query: (args.query as Record<string, string> | undefined) ?? undefined,
        body: args.body,
      });
    },
  },
];

const TOOLS_BY_NAME = new Map(GOOGLE_WORKSPACE_TOOLS.map((tool) => [tool.name, tool]));

function apiError(status: number, data: unknown, text: string): Error {
  const error = (data as { error?: { message?: unknown } | string } | undefined)?.error;
  const message =
    typeof error === "object" && typeof error?.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : text.slice(0, 300) || `HTTP ${status}`;
  return new Error(`Google API ${status}: ${message}`);
}

export function createGoogleApi(accessToken: string, fetchImpl: Fetch, signal: AbortSignal): Api {
  return async (method, url, options = {}) => {
    const target = new URL(url);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    let body: string | undefined;
    if (options.raw) {
      headers["content-type"] = options.raw.contentType;
      body = options.raw.data;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetchImpl(target, {
      method,
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const text = await response.text();
    if (!response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
      throw apiError(response.status, data, text);
    }
    if (options.text) return text;
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return clip(text);
    }
  };
}

/** Bot tools for the Google account the run's user connected in this space. */
export class GoogleWorkspaceConnector implements ConnectorProvider {
  private readonly tokens = new Map<string, { accessToken: string; expiresAt: number }>();

  constructor(
    private readonly deps: { prisma: PrismaClient; secrets: SecretStore; fetch?: Fetch },
  ) {}

  describe() {
    return {
      id: GOOGLE_WORKSPACE_CONNECTOR_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connection = context.connectedConnections?.find(
      (candidate) => candidate.connectorId === GOOGLE_WORKSPACE_CONNECTOR_ID,
    );
    if (!connection) return [];
    return GOOGLE_WORKSPACE_TOOLS.map((tool) => ({
      name: tool.name,
      description: `${tool.description} Account: ${connection.displayName}.`,
      readOnly: tool.readOnly,
      inputSchema: {
        type: "object",
        properties: tool.properties,
        ...(tool.required ? { required: tool.required } : {}),
      },
      route: {
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        toolName: tool.name,
        connectionId: connection.id,
      },
    }));
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const tool = TOOLS_BY_NAME.get(call.tool);
    if (!tool) {
      yield { type: "error", message: `Unknown Google Workspace tool ${call.tool}` };
      return;
    }
    const connection = context.connectedConnections?.find(
      (candidate) =>
        candidate.connectorId === GOOGLE_WORKSPACE_CONNECTOR_ID &&
        (!call.connectionId || candidate.id === call.connectionId),
    );
    if (!connection) {
      yield {
        type: "error",
        message: "No Google account is connected. Connect it in Integrations.",
      };
      return;
    }
    try {
      const accessToken = await this.accessToken(connection.id, context);
      const api = createGoogleApi(accessToken, this.deps.fetch ?? fetch, context.signal);
      yield { type: "result", data: await tool.run(api, call.args ?? {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield {
        type: "error",
        message:
          error instanceof GoogleAuthError && error.revoked
            ? "Google access was revoked or expired. Reconnect Google Workspace in Integrations."
            : message,
      };
    }
  }

  private async accessToken(connectionId: string, context: AdapterContext): Promise<string> {
    const cached = this.tokens.get(connectionId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return cached.accessToken;
    const row = await this.deps.prisma.connection.findFirst({
      where: {
        id: connectionId,
        connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
        status: "connected",
        ...(context.userId ? { userId: context.userId } : {}),
      },
      select: { userId: true, secretId: true },
    });
    if (!row?.secretId)
      throw new Error("No Google account is connected. Connect it in Integrations.");
    const secret = await this.deps.prisma.secret.findUnique({ where: { id: row.secretId } });
    if (!secret) throw new Error("The Google sign-in is missing. Reconnect it in Integrations.");
    const stored = parseGoogleTokens(
      await this.deps.secrets.load(secret.ciphertext, { recordId: secret.id }),
    );
    if (stored.accessToken && stored.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      this.tokens.set(connectionId, stored);
      return stored.accessToken;
    }
    const client = await loadGoogleClient(this.deps.prisma, this.deps.secrets, row.userId);
    if (!client)
      throw new Error("The Google OAuth client was removed. Add it again in Integrations.");
    const fresh = await refreshGoogleToken(
      client.client,
      stored.refreshToken,
      this.deps.fetch ?? fetch,
    );
    const next = { ...stored, ...fresh };
    const sealed = await this.deps.secrets.put(JSON.stringify(next), context, {
      recordId: secret.id,
    });
    await this.deps.prisma.secret.update({
      where: { id: secret.id },
      data: { ciphertext: sealed.ciphertext },
    });
    this.tokens.set(connectionId, fresh);
    return fresh.accessToken;
  }
}
