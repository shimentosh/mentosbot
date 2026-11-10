// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CallSessionModule from "./call-session";
import { SIGNED_IN_USER_KEY } from "./call-session";
import { selectedSpaceId, selectSpace } from "./rpc";
import { switchAccount } from "./signed-in-accounts";

const { request, endCallBeforeSignOut } = vi.hoisted(() => ({
  request: vi.fn(),
  endCallBeforeSignOut: vi.fn(async () => undefined),
}));

vi.mock("./auth", () => ({ authClient: { $fetch: request } }));
vi.mock("./call-session", async (importOriginal) => ({
  ...(await importOriginal<typeof CallSessionModule>()),
  endCallBeforeSignOut,
}));

const location = { assign: vi.fn(), reload: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", location);
  request.mockResolvedValue({ data: { userId: "user-2" }, error: null });
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  selectSpace("space-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("switchAccount", () => {
  it("hangs up first, then opens the other account on a fresh page", async () => {
    await switchAccount("user-2");
    expect(endCallBeforeSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0] ?? 0,
    );
    expect(request).toHaveBeenCalledWith("/signed-in-accounts/switch", {
      method: "POST",
      body: { userId: "user-2" },
    });
    expect(location.assign).toHaveBeenCalledWith("/app");
    // Other tabs reload when the signed-in user is cleared.
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBeNull();
    expect(selectedSpaceId()).toBeNull();
  });

  it.each([
    ["an error result", () => request.mockResolvedValue({ error: { status: 401 } })],
    ["a rejected request", () => request.mockRejectedValue(new Error("Network"))],
  ])("reloads onto the same account after %s", async (_name, fail) => {
    fail();
    await switchAccount("user-2");
    expect(location.reload).toHaveBeenCalledOnce();
    expect(location.assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBe("user-1");
    expect(selectedSpaceId()).toBe("space-1");
  });
});
