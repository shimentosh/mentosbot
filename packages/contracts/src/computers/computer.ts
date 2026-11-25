import * as z from "zod";
import { Id, IsoDate, SandboxKind } from "../ids.js";
import type { ProviderSettingsField } from "../models/provider-settings.js";
import { ProviderSettingsFieldSchema } from "../models/provider-settings.js";

export const ComputerModeSchema = z.enum(["team", "dedicated"]);
export type ComputerMode = z.infer<typeof ComputerModeSchema>;

/** How big a machine a cloud computer runs on. Providers without sizes ignore it. */
export const ComputerSizeSchema = z.enum(["standard", "large", "xlarge"]);
export type ComputerSize = z.infer<typeof ComputerSizeSchema>;

export const COMPUTER_UPDATE_STAGES = [
  "preparing",
  "saving",
  "recreating",
  "restoring",
  "reconnecting",
] as const;
export const ComputerUpdateSchema = z.object({
  canReleaseReservation: z.boolean().optional(),
  action: z.enum(["update", "recover"]),
  id: Id,
  botId: Id,
  name: z.string(),
  mode: ComputerModeSchema,
  status: z.enum(["queued", "running", "interrupted", "completed", "failed"]),
  stage: z.enum(COMPUTER_UPDATE_STAGES),
});
export type ComputerUpdate = z.infer<typeof ComputerUpdateSchema>;

/** The error code of a restore refused because the computer is running. */
export const COMPUTER_RUNNING_ERROR = "COMPUTER_RUNNING";

/** An earlier saved copy of a computer's home that its owner can restore. */
export const ComputerHomeVersionSchema = z.object({ id: Id, savedAt: IsoDate });
export type ComputerHomeVersion = z.infer<typeof ComputerHomeVersionSchema>;

export const ComputerStatusSchema = z.object({
  botId: Id,
  mode: ComputerModeSchema,
  kind: SandboxKind,
  state: z.enum(["stopped", "booting", "running", "suspended", "error"]),
  controlHolder: z.enum(["bot", "user", "none"]),
  controlBotId: Id.nullable(),
  takeoverRequested: z.boolean(),
  screenAvailable: z.boolean(),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  homeRevision: z.string().nullable(),
  busyBotName: z.string().nullable(),
  canUpdate: z.boolean(),
  terminalAvailable: z.boolean(),
  /** True when the computer is the person's own machine, which has no remote screen to show. */
  runsOnUserMachine: z.boolean().optional(),
  /** Set only while the user should see that the disk is nearly full. */
  diskFullPercent: z.number().int().min(0).max(100).optional(),
  /** True when other people share the Space, and with it this computer and its browser sign-ins. */
  shared: z.boolean().optional(),
  /** True when another person in the Space has control, so this viewer only watches. */
  controlledByOther: z.boolean().optional(),
  /** The viewer's own control lease, set only for the person holding it; closing hands it back. */
  controlLeaseId: Id.optional(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

/** A computer screen to load, and how its URL signs the viewer in. */
export const ComputerScreenSchema = z.object({
  url: z.string().nullable(),
  /**
   * Set when the URL signs in with a code that works once and ends the session an earlier code
   * opened, so loading it a second time, or loading a newer one beside it, loses the screen.
   * `screen` names what the URL shows apart from that code: URLs with the same value show the
   * same screen. Absent when the URL can be loaded again, and from older servers.
   */
  singleUseSignIn: z.object({ screen: z.string() }).optional(),
});

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

export const ComputerProviderFieldSchema = ProviderSettingsFieldSchema;
export type ComputerProviderField = ProviderSettingsField;
export const ComputerProviderDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  fields: z.array(ComputerProviderFieldSchema),
  capabilities: z.object({ perAccount: z.boolean() }),
});
export type ComputerProviderDescriptor = z.infer<typeof ComputerProviderDescriptorSchema>;
/** A network of the person's own that their computers' browsers reach the internet through. */
export const NetworkExitDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  fields: z.array(ComputerProviderFieldSchema),
  /** Where setting the network up is explained. */
  helpUrl: z.string().url().optional(),
});
export type NetworkExitDescriptor = z.infer<typeof NetworkExitDescriptorSchema>;
export const NetworkExitStatusSchema = z.object({
  /** Empty when this server's computers can't use one. */
  providers: z.array(NetworkExitDescriptorSchema),
  /** The signed-in person's connection in this Space; secret values are never returned. */
  connection: z
    .object({
      provider: z.string(),
      values: z.record(z.string(), z.string()),
      updatedAt: z.string().datetime({ offset: true }),
    })
    .nullable(),
});
export type NetworkExitStatus = z.infer<typeof NetworkExitStatusSchema>;
export const NetworkExitConnectSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  values: z.record(z.string().max(64), z.string().trim().max(4096)),
});
/** A server of the deployment's own that runs bots' computers. */
export const ComputerServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Where Rakazo signs in to set it up. */
  host: z.string().nullable(),
  maxComputers: z.number().int(),
  /** Computers placed on it, running or not. */
  computers: z.number().int(),
  paused: z.boolean(),
  /** False until the server first answers; it takes no computers before then. */
  ready: z.boolean(),
  setup: z.enum(["installing", "failed"]).nullable(),
  /** Why the last setup failed. */
  setupError: z.string().nullable(),
});
export type ComputerServer = z.infer<typeof ComputerServerSchema>;
export const ComputerServerStatusSchema = z.object({
  /** False when the signed-in person can't manage servers here. */
  canManage: z.boolean(),
  servers: z.array(ComputerServerSchema),
});
export type ComputerServerStatus = z.infer<typeof ComputerServerStatusSchema>;
/** How busy one server that runs computers is, so its owner can tell when to add another. */
export const ComputerServerUsageSchema = z.object({
  /** The server row's id; null for the server this deployment runs on. */
  id: z.string().nullable(),
  name: z.string(),
  /** Null when the server did not answer. */
  usage: z
    .object({
      cpus: z.number().int(),
      /** Runnable processes over the last minute; near `cpus` means every core is busy. */
      load: z.number(),
      memory: z.object({ total: z.number(), available: z.number() }),
      disk: z.object({ total: z.number(), available: z.number() }).nullable(),
      computers: z.array(
        z.object({
          /** A bot's name, or the Space whose team computer it is. */
          name: z.string(),
          team: z.boolean(),
          running: z.boolean(),
          /** Bytes in use while running. */
          memory: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
});
export type ComputerServerUsage = z.infer<typeof ComputerServerUsageSchema>;
const ServerHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]-]+$/);
const ServerSignInSchema = z.object({
  username: z.string().trim().min(1).max(64),
  /** Used for this sign-in only; never stored. */
  password: z.string().min(1).max(1024),
});
export const ComputerServerAddSchema = ServerSignInSchema.extend({
  name: z.string().trim().min(1).max(80),
  /** The address Rakazo signs in to over SSH, with an optional port. */
  host: ServerHostSchema,
  maxComputers: z.number().int().min(1).max(500),
});
export const ComputerServerSetupSchema = ServerSignInSchema.extend({
  id: z.string().min(1).max(64),
});
export const ComputerServerUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80).optional(),
  maxComputers: z.number().int().min(1).max(500).optional(),
  paused: z.boolean().optional(),
});
export const ComputerProviderSettingsSchema = z.object({
  provider: z.string(),
  defaultProvider: z.string(),
  providers: z.array(ComputerProviderDescriptorSchema),
  values: z.record(z.string(), z.string()),
  savedSecrets: z.record(z.string(), z.boolean()),
});
export type ComputerProviderSettings = z.infer<typeof ComputerProviderSettingsSchema>;
export const ComputerProviderUpdateSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  values: z.record(z.string().max(64), z.string().trim().max(4096)).default({}),
});
export type ComputerProviderUpdate = z.infer<typeof ComputerProviderUpdateSchema>;

/**
 * The Space's cloud computers whose size can be chosen. `available` is what the plan allows;
 * the larger sizes still show so an owner can see where an upgrade leads.
 */
export const CloudComputersSchema = z.object({
  computers: z.array(
    z.object({
      id: Id,
      scope: ComputerModeSchema,
      botName: z.string().nullable(),
      /** The size it starts at: the saved size, or the largest the plan allows below it. */
      size: ComputerSizeSchema,
      /** The size its owner chose, which `size` returns to if the plan grows again. */
      savedSize: ComputerSizeSchema,
    }),
  ),
  available: z.array(ComputerSizeSchema),
  /** Size changes what the organization's hours buy, so only who manages billing makes them. */
  canManage: z.boolean(),
});
export type CloudComputers = z.infer<typeof CloudComputersSchema>;

/** Record a confirmed size without inventing a missing row or overriding the list's plan limits. */
export function applySavedCloudComputerSize(
  listed: CloudComputers | null | undefined,
  computerId: string,
  size: ComputerSize,
): CloudComputers | undefined {
  if (!listed?.computers.some((computer) => computer.id === computerId)) return;
  return {
    ...listed,
    computers: listed.computers.map((computer) =>
      computer.id === computerId
        ? {
            ...computer,
            size: listed.available.includes(size) ? size : computer.size,
            savedSize: size,
          }
        : computer,
    ),
  };
}

/**
 * What picking `size` for a cloud computer does: an upgrade prompt when the plan excludes it,
 * nothing when it is already the saved size, otherwise a save. A plan that shrank shows the size
 * it allows, so picking that saves it in place of the larger saved size.
 */
export function computerSizeChoice(
  size: ComputerSize,
  computer: { savedSize: ComputerSize },
  available: readonly ComputerSize[],
): "upgrade" | "unchanged" | "save" {
  if (!available.includes(size)) return "upgrade";
  return size === computer.savedSize ? "unchanged" : "save";
}

/** The vCPUs and memory each computer size provides. */
export const COMPUTER_SIZE_SPECS: Record<ComputerSize, { vcpus: number; memoryGb: number }> = {
  standard: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};
