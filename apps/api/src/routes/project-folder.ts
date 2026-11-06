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

  const open = async (actor: Actor, botId: string) => {
    if (!deps.userDevices) throw new ORPCError("NOT_FOUND");
    try {
      return await openUserComputer({
        devices: deps.userDevices,
        owner: actor.userId,
        botId,
        signal: AbortSignal.timeout(DEVICE_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
  };

  const status = async (
    actor: Actor,
    botId: string,
    available: boolean,
    session?: UserComputerSession,
  ): Promise<ProjectFolderStatus> => {
    if (!available) return { available: false, connected: false, folder: null, processes: [] };
    const [saved, device] = await Promise.all([
      deps.prisma.botFolder.findUnique({
        where: { botId_userId: { botId, userId: actor.userId } },
        select: { path: true, deviceId: true, device: { select: { name: true } } },
      }),
      deps.userDevices?.connected(actor.userId).catch(() => null),
    ]);
    const live = session ?? (device ? await open(actor, botId) : undefined);
    const processes = live ? await listKeptCommands(live).catch(() => []) : [];
    return {
      available: true,
      connected: Boolean(device),
      folder: saved
        ? {
            path: saved.path,
            name: path.basename(saved.path.replaceAll("\\", "/")),
            ...(device && saved.deviceId === device.deviceId
              ? {}
              : { otherComputer: saved.device.name }),
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
        return status(context.actor, input.botId, available);
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
          return status(actor, bot.id, available);
        }
        const session = await open(actor, bot.id);
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
        return status(actor, bot.id, available, session);
      }),
      stop: authed.projectFolder.stop.handler(async ({ context, input }) => {
        const { actor } = context;
        const { available } = await ownBot(actor, input.botId);
        if (!available) throw new ORPCError("NOT_FOUND");
        const session = await open(actor, input.botId);
        if (!session) throw new ORPCError("BAD_REQUEST", { message: OFFLINE });
        try {
          await stopKeptCommand(session, input.name);
        } catch (error) {
          throw failure(error);
        }
        return status(actor, input.botId, available, session);
      }),
    },
  };
}
