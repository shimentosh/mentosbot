import type { PrismaClient } from "@rakazo/db";

/** Records the folder on one of the user's computers that this bot works in for them. */
export async function setBotFolder(
  prisma: PrismaClient,
  folder: { botId: string; userId: string; spaceId: string; deviceId: string; path: string },
): Promise<void> {
  await prisma.botFolder.upsert({
    where: { botId_userId: { botId: folder.botId, userId: folder.userId } },
    create: folder,
    update: { deviceId: folder.deviceId, path: folder.path },
  });
}
