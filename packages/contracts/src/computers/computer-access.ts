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
