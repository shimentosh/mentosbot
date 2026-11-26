import * as z from "zod";
import { Id, IsoDate } from "../ids.js";

export const COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH = 80;

/** A key an outside AI uses to control one bot's computer. The key itself is shown only once. */
export const ComputerAccessKeySchema = z.object({
  id: Id,
  name: z.string(),
  /** The key's last characters, so keys can be told apart. */
  hint: z.string(),
  allowCommands: z.boolean(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
});
export type ComputerAccessKey = z.infer<typeof ComputerAccessKeySchema>;

export const ComputerAccessKeyCreateSchema = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH),
  allowCommands: z.boolean().default(false),
});

export const ComputerAccessKeyCreatedSchema = z.object({
  key: ComputerAccessKeySchema,
  /** The secret, returned only here. */
  token: z.string(),
  /** The MCP endpoint the key works on. */
  url: z.string(),
});
export type ComputerAccessKeyCreated = z.infer<typeof ComputerAccessKeyCreatedSchema>;

/** What an outside AI's sign-in asks for, before the owner says which bot it may use. */
export const ComputerAccessRequestSchema = z.object({
  clientId: z.string().min(1).max(4000),
  redirectUri: z.string().min(1).max(2000),
});

export const ComputerAccessRequestInfoSchema = z.object({
  /** The name the AI registered under. */
  clientName: z.string(),
  /** Where the browser returns once approved. */
  redirectHost: z.string(),
  /** The viewer's own bots with a computer, the ones they can hand over. */
  bots: z.array(z.object({ id: Id, name: z.string() })),
});

export const ComputerAccessApproveSchema = ComputerAccessRequestSchema.extend({
  botId: Id,
  allowCommands: z.boolean().default(false),
  /** PKCE S256 challenge. */
  codeChallenge: z.string().min(43).max(128),
  state: z.string().max(2000).optional(),
});
