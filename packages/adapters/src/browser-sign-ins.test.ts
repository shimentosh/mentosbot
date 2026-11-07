import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { browserSignInShares, mergeSignInCopies, signInGroupKey } from "./browser-sign-ins.js";

const cookie = (name: string, value: string, domain = ".mail.test") => ({ name, value, domain });
const names = (copy: { cookies: Record<string, unknown>[] } | undefined) =>
  (copy?.cookies ?? []).map((c) => `${c.name}=${c.value}`).sort();

/** A row store and a secret store that seals by prefixing, enough to see what is kept. */
function fakeServer(shareSignIns = true) {
  let row: { userId: string; ciphertext: string; version: number } | undefined;
  const sealed = new Set<string>();
  /** Runs once, just before the next update: another computer saving first. */
  let beforeUpdate: (() => void) | undefined;
  const prisma = {
    bot: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "bot-1" ? { shareSignIns, userId: "user-1" } : null,
    },
    browserSignIns: {
      findUnique: async () => (row ? { ...row } : null),
      create: async ({ data }: { data: typeof row & object }) => {
        if (row) throw Object.assign(new Error("unique"), { code: "P2002" });
        row = { ...data };
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { version: number };
        data: { ciphertext: string };
      }) => {
        const race = beforeUpdate;
        beforeUpdate = undefined;
        race?.();
        if (!row || row.version !== where.version) return { count: 0 };
        row = { ...row, ciphertext: data.ciphertext, version: row.version + 1 };
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  let next = 0;
  const secretStore = {
    put: async (plaintext: string) => {
      next += 1;
      const ciphertext = `sealed-${next}:${plaintext}`;
      sealed.add(ciphertext);
      return { id: ciphertext, ref: ciphertext, ciphertext };
    },
    load: async (ciphertext: string) => ciphertext.slice(ciphertext.indexOf(":") + 1),
    delete: async (ciphertext: string) => {
      sealed.delete(ciphertext);
    },
  } as unknown as SecretStore;
  const store = (copy: { cookies: Record<string, unknown>[] }, version = 1) => {
    row = { userId: "user-1", ciphertext: `sealed-0:${JSON.stringify(copy)}`, version };
    sealed.add(row.ciphertext);
  };
  return {
    shares: browserSignInShares({ prisma, secretStore }),
    stored: async () =>
      row ? JSON.parse(row.ciphertext.slice(row.ciphertext.indexOf(":") + 1)) : undefined,
    store,
    sealed,
    race: (fn: () => void) => {
      beforeUpdate = fn;
    },
  };
}

const context = { operationId: "op", traceId: "op" } as AdapterContext;

describe("sign-in groups", () => {
  it("gives a person one group across all their Spaces", () => {
    expect(signInGroupKey("ada")).toMatch(/^[0-9a-f]{32}$/);
    expect(signInGroupKey("ada")).toBe(signInGroupKey("ada"));
    expect(signInGroupKey("grace")).not.toBe(signInGroupKey("ada"));
  });

  it("leaves an Independent browser out", async () => {
    await expect(fakeServer(false).shares("bot-1", context)).resolves.toBeUndefined();
  });

  it("starts a group the server has no copy of as fresh, then keeps the first save", async () => {
    const server = fakeServer();
    const share = await server.shares("bot-1", context);
    expect(share).toMatchObject({ group: signInGroupKey("user-1"), copy: { fresh: true } });
    await share!.save!({ cookies: [cookie("session", "ada")] });
    expect(names(await server.stored())).toEqual(["session=ada"]);
  });

  it("keeps both computers' sign-ins when they save at once", async () => {
    const server = fakeServer();
    server.store({ cookies: [cookie("mail", "old")] });
    const first = await server.shares("bot-1", context);
    const second = await server.shares("bot-1", context);
    await first!.save!({ cookies: [cookie("mail", "old"), cookie("shop", "ada", ".shop.test")] });
    // The second computer started from the same copy and signed in elsewhere meanwhile.
    await second!.save!({ cookies: [cookie("mail", "new")] });
    expect(names(await server.stored())).toEqual(["mail=new", "shop=ada"]);
  });

  it("merges onto a save that lands while this one is sealed", async () => {
    const server = fakeServer();
    server.store({ cookies: [] });
    const share = await server.shares("bot-1", context);
    server.race(() => server.store({ cookies: [cookie("shop", "ada", ".shop.test")] }, 2));
    await share!.save!({ cookies: [cookie("mail", "ada")] });
    expect(names(await server.stored())).toEqual(["mail=ada", "shop=ada"]);
  });

  it("does not leave sealed copies behind", async () => {
    const server = fakeServer();
    server.store({ cookies: [] });
    const share = await server.shares("bot-1", context);
    await share!.save!({ cookies: [cookie("mail", "ada")] });
    expect(server.sealed.size).toBe(1);
  });
});

describe("merging sign-in copies", () => {
  it("applies one browser's sign-out onto the group", () => {
    const base = { cookies: [cookie("mail", "ada"), cookie("shop", "ada", ".shop.test")] };
    const merged = mergeSignInCopies({ cookies: [cookie("shop", "ada", ".shop.test")] }, base, {
      cookies: [cookie("mail", "ada"), cookie("shop", "ada", ".shop.test"), cookie("news", "1")],
    });
    expect(names(merged)).toEqual(["news=1", "shop=ada"]);
  });

  it("drops expired cookies", () => {
    const merged = mergeSignInCopies(
      { cookies: [{ ...cookie("mail", "ada"), expires: 10 }] },
      undefined,
      { cookies: [] },
      20,
    );
    expect(merged.cookies).toEqual([]);
  });
});
