import type { TeamBot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { filterTeamBots, teamMembers, teamPersonName } from "./team-bots.js";

const bot = (id: string, userId: string, archived = false): TeamBot => ({
  id,
  name: id,
  color: "blue",
  avatarSet: "organic",
  owner: { userId, name: userId === "grace" ? "" : userId, email: `${userId}@rakazo.test` },
  status: "idle",
  lastActivityAt: new Date().toISOString(),
  archived,
});

describe("team bots", () => {
  const bots = [bot("a", "ada"), bot("b", "grace"), bot("c", "ada", true), bot("d", "ada")];

  it("offers each teammate once, in the order their bots appear", () => {
    expect(teamMembers(bots).map((member) => member.userId)).toEqual(["ada", "grace"]);
  });

  it("shows active bots, all or one person's", () => {
    expect(filterTeamBots(bots, "all").map((each) => each.id)).toEqual(["a", "b", "d"]);
    expect(filterTeamBots(bots, "ada").map((each) => each.id)).toEqual(["a", "d"]);
  });

  it("names a person by name, or by email when they have none", () => {
    expect(teamPersonName(bots[1]!.owner)).toBe("grace@rakazo.test");
  });
});
