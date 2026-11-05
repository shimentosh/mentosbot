import { describe, expect, it } from "vitest";
import { computerServerOrigin } from "./computer-servers.js";

describe("computer server address", () => {
  it("accepts private network addresses and fills in the supervisor port", () => {
    expect(computerServerOrigin("10.0.0.5")).toBe("http://10.0.0.5:7091");
    expect(computerServerOrigin("http://192.168.1.20:7000")).toBe("http://192.168.1.20:7000");
    // A tailnet address.
    expect(computerServerOrigin("100.101.102.103")).toBe("http://100.101.102.103:7091");
    expect(computerServerOrigin("http://[fd7a:115c:a1e0::1]")).toBe(
      "http://[fd7a:115c:a1e0::1]:7091",
    );
  });

  it("refuses public, loopback, metadata and named addresses", () => {
    for (const raw of [
      "8.8.8.8",
      "127.0.0.1",
      "http://localhost:7091",
      "169.254.169.254",
      "server.example.com",
      "https://10.0.0.5",
      "http://user:pass@10.0.0.5",
      "http://10.0.0.5/path",
      "",
    ])
      expect(() => computerServerOrigin(raw), raw).toThrow();
  });
});
