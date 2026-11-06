import { describe, expect, it } from "vitest";
import { askPreviewImages } from "./run-turn.js";

describe("askPreviewImages", () => {
  const run = { spaceId: "space-1", botId: "bot-1", userId: "ada" };

  it("keeps the asked order and leaves off images the query did not return", async () => {
    const seen: unknown[] = [];
    const prisma = {
      artifact: {
        findMany: async (query: unknown) => {
          seen.push(query);
          return [
            { id: "b", name: "Second.png", mimeType: "image/png" },
            { id: "a", name: "First.jpg", mimeType: "image/jpeg" },
          ];
        },
      },
    } as never;
    expect(await askPreviewImages({ prisma }, run, ["a", "missing", "b"])).toEqual([
      { artifactId: "a", name: "First.jpg", mimeType: "image/jpeg" },
      { artifactId: "b", name: "Second.png", mimeType: "image/png" },
    ]);
    // Only images in this Space that this bot made or its owner added.
    expect(seen).toEqual([
      {
        where: {
          id: { in: ["a", "missing", "b"] },
          spaceId: "space-1",
          mimeType: { startsWith: "image/" },
          OR: [{ botId: "bot-1" }, { userId: "ada" }],
        },
        select: { id: true, name: true, mimeType: true },
      },
    ]);
  });

  it("asks nothing when the draft has no images", async () => {
    const prisma = {
      artifact: {
        findMany: async () => {
          throw new Error("not called");
        },
      },
    } as never;
    expect(await askPreviewImages({ prisma }, run, undefined)).toEqual([]);
  });
});
