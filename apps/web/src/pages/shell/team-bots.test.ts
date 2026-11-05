import type { TeamBot } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({ Trans: () => null, useLingui: () => ({ t: String }) }));
vi.mock("@rakazo/chat-ui/web", () => ({ ChatMarkdown: () => null }));
vi.mock("@rakazo/ui-web", () => ({}));
vi.mock("../../lib/organizations", () => ({ useOrganizations: () => ({}) }));
vi.mock("../../lib/query", () => ({ queryClient: {}, useQueryUserId: () => null }));
vi.mock("../../lib/rpc", () => ({ rpc: {}, selectedSpaceId: () => null }));

const { teamMembers } = await import("@rakazo/core");

const bot = (id: string, userId: string, name: string): TeamBot => ({
  id,
  name: id,
  color: "blue",
  avatarSet: "organic",
  owner: { userId, name, email: `${userId}@rakazo.test` },
  status: "idle",
  lastActivityAt: new Date().toISOString(),
  archived: false,
});

it("offers each teammate once, in the order their bots appear", () => {
  expect(
    teamMembers([bot("a", "ada", "Ada"), bot("b", "grace", "Grace"), bot("c", "ada", "Ada")]).map(
      (member) => member.userId,
    ),
  ).toEqual(["ada", "grace"]);
});
