import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import { privateAddresses, setUpServerOverSsh } from "./server-setup.js";

const IP_ADDR = `1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever
2: eth0    inet 203.0.113.7/20 brd 203.0.127.255 scope global eth0
2: eth0    inet 10.17.0.5/16 brd 10.17.255.255 scope global eth0
3: eth1    inet 10.110.0.2/20 brd 10.110.15.255 scope global eth1
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
5: tailscale0    inet 100.101.102.103/32 scope global tailscale0
6: br-1a2b3c    inet 172.18.0.1/16 scope global br-1a2b3c
5: tailscale0    inet6 fd7a:115c:a1e0::1/128 scope global`;

function fakeClient(options: { fail?: "auth" | "network"; codes?: Record<string, number> } = {}) {
  const calls: Array<{ command: string; stdin?: string }> = [];
  const client = new EventEmitter() as EventEmitter & {
    connect: (config: unknown) => void;
    exec: (command: string, cb: (error: Error | undefined, stream: unknown) => void) => void;
    end: () => void;
    ended: boolean;
  };
  client.ended = false;
  client.connect = () => {
    setImmediate(() => {
      if (options.fail === "auth")
        client.emit(
          "error",
          Object.assign(new Error("denied"), { level: "client-authentication" }),
        );
      else if (options.fail === "network") client.emit("error", new Error("ECONNREFUSED"));
      else client.emit("ready");
    });
  };
  client.exec = (command, cb) => {
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      end: (stdin?: string) => void;
      close: () => void;
    };
    stream.stderr = new EventEmitter();
    stream.close = () => {};
    const call: { command: string; stdin?: string } = { command };
    calls.push(call);
    stream.end = (stdin) => {
      call.stdin = stdin;
      setImmediate(() => {
        if (command === "ip -o addr show") stream.emit("data", Buffer.from(IP_ADDR));
        const code = Object.entries(options.codes ?? {}).find(([prefix]) =>
          command.includes(prefix),
        )?.[1];
        if (code) stream.stderr.emit("data", Buffer.from("apt failed\nNo space left on device\n"));
        stream.emit("close", code ?? 0);
      });
    };
    cb(undefined, stream);
  };
  client.end = () => {
    client.ended = true;
  };
  return { client: client as unknown as Client & { ended: boolean }, calls };
}

const request = (
  client: Client,
  extra: Partial<Parameters<typeof setUpServerOverSsh>[0]> = {},
) => ({
  host: "203.0.113.7",
  username: "root",
  password: "secret pass",
  token: "tok-en_1",
  script: "#!/bin/bash\necho hi\n",
  client: async () => client,
  reachable: async (address: string) => address === "10.110.0.2",
  ...extra,
});

describe("server setup over SSH", () => {
  it("finds the server's private addresses and skips Docker's own networks", () => {
    expect(privateAddresses(IP_ADDR)).toEqual([
      "10.17.0.5",
      "10.110.0.2",
      "100.101.102.103",
      "fd7a:115c:a1e0::1",
    ]);
  });

  it("installs as root at the private address this machine reaches", async () => {
    const { client, calls } = fakeClient();
    const result = await setUpServerOverSsh(request(client));
    expect(result.address).toBe("10.110.0.2");
    expect(calls.map((call) => call.command)).toEqual([
      "ip -o addr show",
      "umask 077 && cat > /tmp/rakazo-server-install.sh",
      "bash /tmp/rakazo-server-install.sh --token 'tok-en_1' --address '10.110.0.2'",
      "rm -f /tmp/rakazo-server-install.sh",
    ]);
    expect(calls[1]!.stdin).toBe("#!/bin/bash\necho hi\n");
    // Root needs no password on the way in.
    expect(calls[2]!.stdin).toBeUndefined();
    expect(client.ended).toBe(true);
  });

  it("runs setup through sudo for another user, giving the password only to sudo", async () => {
    const { client, calls } = fakeClient();
    await setUpServerOverSsh(request(client, { username: "debian" }));
    expect(calls[2]!.command).toBe(
      "sudo -S -p '' bash /tmp/rakazo-server-install.sh --token 'tok-en_1' --address '10.110.0.2'",
    );
    expect(calls[2]!.stdin).toBe("secret pass\n");
  });

  it("says when the username or password is wrong", async () => {
    const { client } = fakeClient({ fail: "auth" });
    await expect(setUpServerOverSsh(request(client))).rejects.toThrow(
      "refused this username or password",
    );
  });

  it("stops before installing when no private address is reachable", async () => {
    const { client, calls } = fakeClient();
    await expect(
      setUpServerOverSsh(request(client, { reachable: async () => false })),
    ).rejects.toThrow("shares no private network");
    expect(calls).toHaveLength(1);
    expect(client.ended).toBe(true);
  });

  it("reports the last line the setup printed when it fails", async () => {
    const { client } = fakeClient({ codes: { "bash /tmp/rakazo": 1 } });
    await expect(setUpServerOverSsh(request(client))).rejects.toThrow("No space left on device");
  });
});
