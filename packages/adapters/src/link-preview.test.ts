import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createLinkPreviewResolver,
  linkPreviewImageDataUrl,
  linkPreviewTags,
  linkPreviewUrl,
} from "./link-preview.js";
import type { ResolveHostname } from "./network-address.js";

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Holds the reply until the test releases it. */
  hold?: Promise<void>;
};

// Every site is a canned reply; nothing leaves the machine.
const routes = new Map<string, Reply>();
const hits: string[] = [];

const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const key = `${url.host}${url.pathname}${url.search}`;
  hits.push(key);
  const reply = routes.get(key);
  await reply?.hold;
  const body = reply?.body ?? "";
  return new Response(typeof body === "string" ? body : new Blob([new Uint8Array(body)]), {
    status: reply ? (reply.status ?? 200) : 404,
    headers: reply?.headers,
  });
};

const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

function resolvingTo(addresses: Record<string, string>): ResolveHostname {
  return async (hostname) => {
    const address = addresses[hostname] ?? "203.0.113.10";
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

const html = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

function page(head: string, headers: Record<string, string> = {}): Reply {
  return { body: html(head), headers: { "content-type": "text/html; charset=utf-8", ...headers } };
}

async function picture(width: number, height: number, alpha = 1): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 90, b: 160, alpha } },
  })
    .png()
    .toBuffer();
}

function resolver(options: Parameters<typeof createLinkPreviewResolver>[0] = {}) {
  return createLinkPreviewResolver({
    fetch: fakeFetch,
    resolveHostname: publicResolver,
    decode: async () => "data:image/jpeg;base64,AAAA",
    ...options,
  });
}

beforeEach(() => {
  routes.clear();
  hits.length = 0;
});

describe("link preview tags", () => {
  it("prefers Open Graph, then Twitter card, then plain HTML tags", () => {
    const tags = linkPreviewTags(
      html(`
        <title>Plain title</title>
        <meta name="description" content="Plain description">
        <meta name="twitter:title" content="Card title">
        <meta property="og:title" content="Graph title">
        <meta property="og:description" content="Graph description">
        <meta property="og:site_name" content="Example News">
        <meta property="og:image" content="/cover.png">
      `),
      "https://news.example.test/story/1",
    );
    expect(tags).toEqual({
      title: "Graph title",
      description: "Graph description",
      siteName: "Example News",
      imageUrl: "https://news.example.test/cover.png",
    });
  });

  it("falls back to the card tags and the document title", () => {
    expect(
      linkPreviewTags(
        html(`
          <title> Plain &amp; simple </title>
          <meta name="twitter:description" content="Card description">
          <meta name="twitter:image" content="https://cdn.example.test/a.jpg">
        `),
        "https://example.test/",
      ),
    ).toEqual({
      title: "Plain & simple",
      description: "Card description",
      siteName: null,
      imageUrl: "https://cdn.example.test/a.jpg",
    });
  });

  it("gives no preview for a page without a title", () => {
    expect(
      linkPreviewTags(html(`<meta name="description" content="Only words">`), "https://a.test/"),
    ).toBeNull();
  });

  it("resolves a relative image against the page's base", () => {
    const tags = linkPreviewTags(
      html(`<title>T</title><base href="https://static.example.test/assets/">
        <meta property="og:image" content="cover.jpg">`),
      "https://example.test/post",
    );
    expect(tags?.imageUrl).toBe("https://static.example.test/assets/cover.jpg");
  });

  it("drops image addresses that are not plain http(s)", () => {
    for (const image of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "https://user:secret@cdn.example.test/a.png",
    ]) {
      const tags = linkPreviewTags(
        html(`<title>T</title><meta property="og:image" content="${image}">`),
        "https://example.test/",
      );
      expect(tags?.imageUrl).toBeNull();
    }
  });

  it("strips hidden characters, folds whitespace and shortens long text", () => {
    const tags = linkPreviewTags(
      html(`<meta property="og:title" content="Safe‮txt.exe​
        title"><meta property="og:description" content="${"word ".repeat(200)}">`),
      "https://example.test/",
    );
    expect(tags?.title).toBe("Safe txt.exe title");
    expect(Array.from(tags!.description!)).toHaveLength(300);
    expect(tags?.description?.endsWith("…")).toBe(true);
  });

  it("does not read tags from the body, which a page's visitors may have written", () => {
    expect(
      linkPreviewTags(
        html(`<title>Real</title>`, `<meta property="og:title" content="Injected">`),
        "https://example.test/",
      )?.title,
    ).toBe("Real");
  });
});

describe("link preview URL", () => {
  it("keeps plain http(s) links without their fragment", () => {
    expect(linkPreviewUrl("https://example.test/a?b=1#c")).toBe("https://example.test/a?b=1");
    expect(linkPreviewUrl("http://example.test")).toBe("http://example.test/");
  });

  it("refuses other schemes, credentials, explicit ports and overlong links", () => {
    for (const url of [
      "ftp://example.test/",
      "javascript:alert(1)",
      "https://user:pass@example.test/",
      "https://example.test:8443/",
      `https://example.test/${"a".repeat(2048)}`,
      "not a url",
    ]) {
      expect(linkPreviewUrl(url)).toBeUndefined();
    }
  });
});

describe("link preview resolver", () => {
  it("reads a page and proxies its image as a data URL", async () => {
    routes.set(
      "example.test/post",
      page(`<meta property="og:title" content="Post"><meta property="og:image" content="/i.png">`),
    );
    routes.set("example.test/i.png", { body: await picture(1200, 630) });
    const answer = await resolver({ decode: undefined }).preview("https://example.test/post#top");
    expect(answer.preview).toMatchObject({ title: "Post", description: null, siteName: null });
    expect(answer.preview?.image).toMatch(/^data:image\/(png|jpeg);base64,/);
    expect(hits).toEqual(["example.test/post", "example.test/i.png"]);
  });

  it("still answers when the image cannot be fetched", async () => {
    routes.set(
      "example.test/post",
      page(`<title>Post</title><meta property="og:image" content="/missing.png">`),
    );
    const answer = await resolver().preview("https://example.test/post");
    expect(answer).toEqual({
      preview: { title: "Post", description: null, siteName: null, image: null },
    });
  });

  it("never fetches a private address, for the page or its image", async () => {
    routes.set("internal.test/", page(`<title>Secret</title>`));
    const resolve = resolvingTo({
      "internal.test": "10.0.0.5",
      "metadata.test": "169.254.169.254",
    });
    expect(await resolver({ resolveHostname: resolve }).preview("https://internal.test/")).toEqual({
      preview: null,
    });
    expect(hits).toEqual([]);

    routes.set(
      "example.test/",
      page(`<title>T</title><meta property="og:image" content="https://metadata.test/x.png">`),
    );
    const answer = await resolver({ resolveHostname: resolve }).preview("https://example.test/");
    expect(answer.preview?.image).toBeNull();
    expect(hits).toEqual(["example.test/"]);
  });

  it("does not follow a redirect to a private address", async () => {
    routes.set("example.test/go", { status: 302, headers: { location: "http://127.0.0.1/" } });
    expect(await resolver().preview("https://example.test/go")).toEqual({ preview: null });
    expect(hits).toEqual(["example.test/go"]);
  });

  it("follows at most three redirects", async () => {
    for (let hop = 0; hop < 4; hop += 1) {
      routes.set(`example.test/${hop}`, {
        status: 302,
        headers: { location: `/${hop + 1}` },
      });
    }
    routes.set("example.test/4", page("<title>Far</title>"));
    expect(await resolver().preview("https://example.test/0")).toEqual({ preview: null });
    expect(hits).toHaveLength(4);
  });

  it("ignores a link that is not a web page", async () => {
    routes.set("example.test/file.pdf", {
      body: "<title>Not really</title>",
      headers: { "content-type": "application/pdf" },
    });
    expect(await resolver().preview("https://example.test/file.pdf")).toEqual({ preview: null });
  });

  it("reads only the start of a huge page", async () => {
    const head = `<title>Big</title>`;
    routes.set("example.test/big", {
      body: `${html(head)}${"x".repeat(4 * 1024 * 1024)}`,
      headers: { "content-type": "text/html" },
    });
    expect((await resolver().preview("https://example.test/big")).preview?.title).toBe("Big");
  });

  it("decodes the page's declared charset", async () => {
    // "Café" in Latin-1.
    const body = new Uint8Array([
      ...new TextEncoder().encode("<html><head><title>Caf"),
      0xe9,
      ...new TextEncoder().encode("</title></head></html>"),
    ]);
    routes.set("example.test/", { body, headers: { "content-type": "text/html; charset=latin1" } });
    expect((await resolver().preview("https://example.test/")).preview?.title).toBe("Café");
  });

  it("refuses links it must not fetch without touching the network", async () => {
    const lookup = resolver();
    for (const url of ["https://user:pw@example.test/", "https://example.test:8080/", "file:///"]) {
      expect(await lookup.preview(url)).toEqual({ preview: null });
    }
    expect(hits).toEqual([]);
  });

  it("caches answers, misses included, until they expire", async () => {
    let now = 0;
    const lookup = resolver({ now: () => now });
    routes.set("example.test/a", page("<title>A</title>"));
    await lookup.preview("https://example.test/a");
    await lookup.preview("https://example.test/a#again");
    await lookup.preview("https://example.test/missing");
    await lookup.preview("https://example.test/missing");
    expect(hits).toEqual(["example.test/a", "example.test/missing"]);

    now += 61 * 60 * 1000;
    await lookup.preview("https://example.test/a");
    await lookup.preview("https://example.test/missing");
    expect(hits).toEqual(["example.test/a", "example.test/missing", "example.test/missing"]);

    now += 12 * 60 * 60 * 1000;
    await lookup.preview("https://example.test/a");
    expect(hits.filter((hit) => hit === "example.test/a")).toHaveLength(2);
  });

  it("keeps the cache within its byte budget, dropping the oldest answers", async () => {
    const lookup = resolver({
      limits: { maxCachedBytes: 1_000 },
      decode: async () => `data:image/jpeg;base64,${"A".repeat(400)}`,
    });
    for (const name of ["a", "b", "c"]) {
      routes.set(
        `example.test/${name}`,
        page(`<title>${name}</title><meta property="og:image" content="/${name}.png">`),
      );
      routes.set(`example.test/${name}.png`, { body: "image" });
      await lookup.preview(`https://example.test/${name}`);
    }
    hits.length = 0;
    await lookup.preview("https://example.test/c");
    expect(hits).toEqual([]);
    await lookup.preview("https://example.test/a");
    expect(hits).toContain("example.test/a");
  });

  it("asks once for a link many readers open at the same moment", async () => {
    let release!: () => void;
    routes.set("example.test/", {
      ...page("<title>Shared</title>"),
      hold: new Promise((resolve) => {
        release = resolve;
      }),
    });
    const lookup = resolver();
    const answers = Promise.all(
      ["u1", "u2", "u3"].map((user) => lookup.preview("https://example.test/", user)),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    expect((await answers).map((answer) => answer.preview?.title)).toEqual([
      "Shared",
      "Shared",
      "Shared",
    ]);
    expect(hits).toEqual(["example.test/"]);
  });

  it("turns one reader's lookups beyond their share away as busy, not missing", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const name of ["a", "b", "c"]) {
      routes.set(`example.test/${name}`, { ...page(`<title>${name}</title>`), hold });
    }
    const lookup = resolver({ limits: { maxPerRequester: 2 } });
    const running = [
      lookup.preview("https://example.test/a", "reader"),
      lookup.preview("https://example.test/b", "reader"),
    ];
    expect(await lookup.preview("https://example.test/c", "reader")).toEqual({
      preview: null,
      retry: true,
    });
    // Someone else is not held back by that reader.
    const other = lookup.preview("https://example.test/c", "someone-else");
    release();
    await Promise.all(running);
    expect((await other).preview?.title).toBe("c");
    // A busy answer is not remembered.
    expect((await lookup.preview("https://example.test/c", "reader")).preview?.title).toBe("c");
  });

  it("turns lookups beyond a full queue away at once, as busy", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const name of ["a", "b", "c"]) {
      routes.set(`example.test/${name}`, { ...page(`<title>${name}</title>`), hold });
    }
    const lookup = resolver({ limits: { maxConcurrent: 1, maxWaiting: 1, maxWaitMs: 60_000 } });
    const first = lookup.preview("https://example.test/a");
    const queued = lookup.preview("https://example.test/b");
    expect(await lookup.preview("https://example.test/c")).toEqual({ preview: null, retry: true });
    release();
    await Promise.all([first, queued]);
  });

  it("gives up on a slow site at the lookup deadline", async () => {
    routes.set("slow.test/", { ...page("<title>Slow</title>"), hold: new Promise(() => {}) });
    const started = Date.now();
    expect(await resolver({ limits: { deadlineMs: 50 } }).preview("https://slow.test/")).toEqual({
      preview: null,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("link preview image", () => {
  it("re-encodes a landscape image at most 640 px wide", async () => {
    const url = await linkPreviewImageDataUrl(await picture(1600, 840));
    expect(url).toMatch(/^data:image\/(png|jpeg);base64,/);
    const bytes = Buffer.from(url!.split(",")[1]!, "base64");
    const { width, height } = await sharp(bytes).metadata();
    expect(width).toBe(640);
    expect(height).toBe(336);
  });

  it("keeps transparency as PNG and draws opaque pictures as JPEG", async () => {
    expect(await linkPreviewImageDataUrl(await picture(800, 400, 0.5))).toMatch(
      /^data:image\/png;/,
    );
    const opaque = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    expect(await linkPreviewImageDataUrl(opaque)).toMatch(/^data:image\/jpeg;/);
  });

  it("skips small, square and portrait images, which are logos or avatars", async () => {
    expect(await linkPreviewImageDataUrl(await picture(150, 80))).toBeNull();
    expect(await linkPreviewImageDataUrl(await picture(400, 400))).toBeNull();
    expect(await linkPreviewImageDataUrl(await picture(400, 800))).toBeNull();
  });

  it("refuses anything that is not a raster image, whatever it claims to be", async () => {
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"></svg>`,
    );
    expect(await linkPreviewImageDataUrl(svg)).toBeNull();
    expect(await linkPreviewImageDataUrl(new TextEncoder().encode("<html></html>"))).toBeNull();
    expect(await linkPreviewImageDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("refuses an image whose declared size is over the pixel limit before decoding it", async () => {
    // A PNG header claiming 5000 × 3000 pixels with no image data behind it.
    const header = await picture(1, 1);
    const huge = Buffer.from(header);
    huge.writeUInt32BE(5000, 16);
    huge.writeUInt32BE(3000, 20);
    expect(await linkPreviewImageDataUrl(huge)).toBeNull();
  });
});
