import { describe, expect, it } from "vitest";
import { networkExitDescriptors, networkExitProvider } from "./network-exit.js";

const key = "tskey-auth-kAbCdEf1CNTRL-0123456789abcdefABCDEF";

describe("tailscale network exit", () => {
  it("keeps the auth key out of the settings that are shown again", () => {
    expect(
      networkExitProvider("tailscale").verify({ authKey: ` ${key} `, exitNode: "pixel-7" }),
    ).toEqual({ settings: { exitNode: "pixel-7" }, credentials: { authKey: key } });
  });

  it.each([
    [{ authKey: "", exitNode: "pixel-7" }, "Auth key is required"],
    [{ authKey: "not-a-key", exitNode: "pixel-7" }, "Auth key must be"],
    [{ authKey: key, exitNode: "pixel 7; rm -rf /" }, "Exit node must be"],
    [{ authKey: key, exitNode: "--advertise-routes=0.0.0.0/0" }, "Exit node must be"],
    [{ authKey: key, exitNode: "pixel-7", extra: "x" }, "Unknown network setting"],
  ])("refuses %j", (values, message) => {
    expect(() => networkExitProvider("tailscale").verify(values)).toThrow(message);
  });

  it("describes its fields without any secret values", () => {
    expect(networkExitDescriptors()).toEqual([
      expect.objectContaining({
        id: "tailscale",
        fields: [
          expect.objectContaining({ key: "authKey", kind: "secret" }),
          expect.objectContaining({ key: "exitNode", kind: "text" }),
        ],
      }),
    ]);
  });
});
