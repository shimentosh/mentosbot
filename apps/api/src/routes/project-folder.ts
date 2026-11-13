import path from "node:path";
import { ORPCError } from "@orpc/server";
import type { UserComputerSession } from "@rakazo/adapters";
import {
  checkUserComputerFolder,
  listKeptCommands,
  listUserComputerFolders,
  openUserComputer,
  setBotFolder,
  stopKeptCommand,
} from "@rakazo/adapters";
import type { Actor, ProjectFolderStatus } from "@rakazo/contracts";
import type { RouterContext } from "./context.js";

const DEVICE_TIMEOUT_MS = 45_000;
const FOLDER_PICKER = "folder-picker";
const OFFLINE = "Open the Rakazo desktop app on your computer to choose a folder there.";

/** A bot's project folder on its owner's computer, chosen and watched from its settings. */
export function projectFolderRoutes(ctx: RouterContext) {
  const { deps, authed, repos } = ctx;

  /** The owner's own bot, unless it is shared with teammates: those never reach the owner's computer. */
  const ownBot = async (actor: Actor, botId: string) => {
    const bot = await repos.getBot(actor, botId);
    const shared = (await deps.prisma.botAccess.count({ where: { botId: bot.id } })) > 0;
    return { bot, available: Boolean(deps.userDevices) && !shared };
  };

  const open = async (actor: Actor, botId: string, deviceId?: string) => {
    if (!deps.userDevices) throw new ORPCError("NOT_FOUND");
    try {
      return await openUserComputer({
        devices: deps.userDevices,
        owner: actor.userId,
        ...(deviceId ? { deviceId } : {}),
        botId,
        signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
  };

  const savedFolder = (actor: Actor, botId: string) =>
    deps.prisma.botFolder.findUnique({
      where: { botId_userId: { botId, userId: actor.userId } },
      select: { path: true, deviceId: true, device: { select: { name: true } } },
    });

  /**
   * The computer to work with: the one the page runs on when it says so, otherwise the one
   * holding the folder while it is connected, otherwise the latest connected.
   */
  const computer = async (actor: Actor, requested?: string, folderDeviceId?: string) => {
    const devices = deps.userDevices;
    if (!devices) return undefined;
    const connected = (deviceId?: string) =>
      devices.connected(actor.userId, deviceId).catch(() => null);
    if (requested) return (await connected(requested))?.deviceId;
    return ((folderDeviceId ? await connected(folderDeviceId) : null) ?? (await connected()))
      ?.deviceId;
  };

  const status = async (
    actor: Actor,
    botId: string,
    available: boolean,
    requested?: string,
    session?: UserComputerSession,
  ): Promise<ProjectFolderStatus> => {
    if (!available) return { available: false, connected: false, folder: null, processes: [] };
    const saved = await savedFolder(actor, botId);
    const deviceId = session?.deviceId ?? (await computer(actor, requested, saved?.deviceId));
    const live = session ?? (deviceId ? await open(actor, botId, deviceId) : undefined);
    const processes = live ? await listKeptCommands(live).catch(() => []) : [];
    return {
      available: true,
      connected: Boolean(deviceId),
      folder: saved
        ? {
            path: saved.path,
            name: path.basename(saved.path.replaceAll("\\", "/")),
            ...(saved.deviceId === deviceId ? {} : { otherComputer: saved.device.name }),
          }
        : null,
      processes,
    };
  };

  const failure = (error: unknown) =>
    new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Your computer did not answer.",
    });

  return {
    projectFolder: {
      get: authed.projectFolder.get.handler(async ({ context, input }) => {
        const { available } = await ownBot(context.actor, input.botId);
        return status(context.actor, input.botId, available, input.deviceId);
      }),
      browse: authed.projectFolder.browse.handler(async ({ context, input }) => {
        if (input.botId && !(await ownBot(context.actor, input.botId)).available)
          throw new ORPCError("NOT_FOUND");
        // A bot being created from a folder has no id yet: its picker browses on its own.
        const session = await open(context.actor, input.botId ?? FOLDER_PICKER);
        if (!session) throw new ORPCError("BAD_REQUEST", { message: OFFLINE });
        try {
          return await listUserComputerFolders(session, input.path ?? "");
        } catch (error) {
          throw failure(error);
        }
      }),
      set: authed.projectFolder.set.handler(async ({ context, input }) => {
        const { actor } = context;
        const { bot, available } = await ownBot(actor, input.botId);
        if (!available) throw new ORPCError("NOT_FOUND");
        if (input.path === null) {
          await deps.prisma.botFolder.deleteMany({
            where: { botId: bot.id, userId: actor.userId },
          });
          return status(actor, bot.id, available, input.deviceId);
        }
        const session = await open(actor, bot.id, input.deviceId);
        if (!session) throw new ORPCError("BAD_REQUEST", { message: OFFLINE });
        let folder: string;
        try {
          folder = await checkUserComputerFolder(session, input.path);
        } catch (error) {
          throw failure(error);
        }
        await setBotFolder(deps.prisma, {
          botId: bot.id,
          userId: actor.userId,
          spaceId: bot.spaceId,
          deviceId: session.deviceId,
          path: folder,
        });
        return status(actor, bot.id, available, input.deviceId, session);
      }),
      stop: authed.projectFolder.stop.handler(async ({ context, input }) => {
        const { actor } = context;
        const { available } = await ownBot(actor, input.botId);
        if (!available) throw new ORPCError("NOT_FOUND");
        // Kept commands run on the folder's computer, which may not be the latest connected.
        const saved = await savedFolder(actor, input.botId);
        const deviceId = await computer(actor, input.deviceId, saved?.deviceId);
        const session = deviceId ? await open(actor, input.botId, deviceId) : undefined;
        if (!session) throw new ORPCError("BAD_REQUEST", { message: OFFLINE });
        try {
          await stopKeptCommand(session, input.name);
        } catch (error) {
          throw failure(error);
        }
        return status(actor, input.botId, available, input.deviceId, session);
      }),
    },
  };
}
