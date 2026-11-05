import { describe, expect, it } from "vitest";
import { sshTarget, supervisorOrigin } from "./computer-servers.js";

describe("computer server addresses", () => {
  it("reads where to sign in, with the SSH port by default", () => {
    expect(sshTarget("203.0.113.7")).toEqual({ host: "203.0.113.7", port: 22 });
    expect(sshTarget(" vps.example.com:2222 ")).toEqual({ host: "vps.example.com", port: 2222 });
    expect(sshTarget("[2001:db8::1]:2200")).toEqual({ host: "2001:db8::1", port: 2200 });
    expect(sshTarget("2001:db8::1")).toEqual({ host: "2001:db8::1", port: 22 });
  });

  it("refuses an impossible port", () => {
    expect(() => sshTarget("203.0.113.7:0")).toThrow();
    expect(() => sshTarget("203.0.113.7:70000")).toThrow();
  });

  it("brackets IPv6 supervisor addresses", () => {
    expect(supervisorOrigin("10.0.0.5")).toBe("http://10.0.0.5:7091");
    expect(supervisorOrigin("fd7a:115c:a1e0::1")).toBe("http://[fd7a:115c:a1e0::1]:7091");
  });
});
