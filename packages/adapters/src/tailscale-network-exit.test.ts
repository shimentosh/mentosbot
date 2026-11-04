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
      expect.objectContaining({
        id: "proxy",
        fields: [
          expect.objectContaining({ key: "address", kind: "text" }),
          expect.objectContaining({ key: "username", kind: "text", required: false }),
          expect.objectContaining({ key: "password", kind: "secret", required: false }),
        ],
      }),
    ]);
  });
});

describe("proxy network exit", () => {
  const proxy = () => networkExitProvider("proxy");

  it("keeps the password encrypted and the rest shown again", () => {
    expect(
      proxy().verify({ address: "proxy.example.com:8080", username: "me", password: "s3cret" }),
    ).toEqual({
      settings: { address: "proxy.example.com:8080", username: "me" },
      credentials: { password: "s3cret" },
    });
    expect(proxy().verify({ address: "[2001:db8::1]:3128" }).settings).toEqual({
      address: "[2001:db8::1]:3128",
    });
  });

  it.each([
    [{ address: "proxy.example.com" }, "host and port"],
    [{ address: "proxy.example.com:70000" }, "host and port"],
    [{ address: "localhost:8080" }, "public address"],
    [{ address: "10.0.0.5:8080" }, "public address"],
    [{ address: "169.254.169.254:80" }, "public address"],
    [{ address: "proxy.example.com:8080", username: "me" }, "both a username and a password"],
    [{ address: "proxy.example.com:8080", username: "me", password: "a b" }, "can't contain"],
  ])("refuses %j", (values, message) => {
    expect(() => proxy().verify(values)).toThrow(message);
  });
});
