import * as z from "zod";
import { Id } from "./ids.js";

/** A command a bot keeps running on its owner's computer, such as a dev server. */
export const KeptCommandSchema = z.object({
  name: z.string(),
  running: z.boolean(),
  command: z.string(),
  folder: z.string(),
  ports: z.array(z.number().int()),
});
export type KeptCommand = z.infer<typeof KeptCommandSchema>;

/** The folder on the owner's computer a bot works in, and what it keeps running there. */
export const ProjectFolderStatusSchema = z.object({
  /** False for a bot shared with teammates: it never reaches its owner's computer. */
  available: z.boolean(),
  /** Whether the owner's desktop app is connected right now. */
  connected: z.boolean(),
  folder: z
    .object({
      path: z.string(),
      name: z.string(),
      /** Set when the folder is on another of the owner's computers than the one in use. */
      otherComputer: z.string().optional(),
    })
    .nullable(),
  processes: z.array(KeptCommandSchema),
});
export type ProjectFolderStatus = z.infer<typeof ProjectFolderStatusSchema>;

export const FolderListingSchema = z.object({
  home: z.string(),
  path: z.string(),
  parent: z.string().nullable(),
  folders: z.array(z.object({ name: z.string(), project: z.boolean() })),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

/**
 * The computer the page runs on, sent by its desktop app so a person with several computers
 * signed in works with this one. Without it, the folder's computer or the latest connected one.
 */
const DeviceId = z.string().min(1).max(64).optional();

export const ProjectFolderInput = z.object({ botId: Id, deviceId: DeviceId });
export const ProjectFolderBrowseInput = z.object({
  /** Absent while a bot is being created from a folder. */
  botId: Id.optional(),
  path: z.string().max(4096).optional(),
});
export const ProjectFolderSetInput = z.object({
  botId: Id,
  /** Null stops using a folder. */
  path: z.string().trim().min(1).max(4096).nullable(),
  deviceId: DeviceId,
});
export const ProjectFolderStopInput = z.object({
  botId: Id,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  deviceId: DeviceId,
});
