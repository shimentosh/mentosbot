import type { AdapterContext, WebFetchProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { SCRIPT_PAGE_HINT, webFetchFromTool } from "./web-tools.js";

const context = { signal: new AbortController().signal } as AdapterContext;

function provider(text: string): WebFetchProvider {
  return {
    describe: () => ({ id: "fake", contractVersion: "1", adapterVersion: "0", capabilities: {} }),
    fetch: async (request: { url: string }) => ({
      url: request.url,
      title: "Page",
      text,
      truncated: false,
    }),
  } as unknown as WebFetchProvider;
}

describe("web_fetch", () => {
  it("points a page that needs script to the page browser, when the run has it", async () => {
    const url = "https://app.example.test/";
    expect(await webFetchFromTool(provider("Loading…"), context, { url }, true)).toMatchObject({
      hint: SCRIPT_PAGE_HINT,
    });
    const notice = `You need to enable JavaScript to run this app. ${"x".repeat(400)}`;
    expect(await webFetchFromTool(provider(notice), context, { url }, true)).toMatchObject({
      hint: SCRIPT_PAGE_HINT,
    });
    // A readable page, a run without the browser, or a later part of a long page gets no hint.
    const article = "A long article about the city. ".repeat(20);
    expect(await webFetchFromTool(provider(article), context, { url }, true)).not.toHaveProperty(
      "hint",
    );
    expect(await webFetchFromTool(provider(""), context, { url }, false)).not.toHaveProperty(
      "hint",
    );
    expect(
      await webFetchFromTool(provider(""), context, { url, offset: 8000 }, true),
    ).not.toHaveProperty("hint");
  });
});
