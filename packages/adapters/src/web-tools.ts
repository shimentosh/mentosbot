import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults, clampOffset } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required" };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Less readable text than this usually means the page draws itself with script. */
const SCRIPT_PAGE_TEXT = 200;
const NEEDS_SCRIPT =
  /\b(?:enable|requires?|turn on) javascript\b|\bjavascript (?:is )?(?:required|disabled)\b/i;
export const SCRIPT_PAGE_HINT =
  "This page shows little or no text without JavaScript. Open it with browser_navigate to read it.";

export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
  /** Whether the run has the page browser, which runs the page's script. */
  browser = false,
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required" };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        offset: clampOffset(args.offset),
        signal: context.signal,
      },
      context,
    );
    const text = result.text.trim();
    if (
      browser &&
      !clampOffset(args.offset) &&
      (text.length < SCRIPT_PAGE_TEXT || NEEDS_SCRIPT.test(text.slice(0, 2000)))
    )
      return { ...result, hint: SCRIPT_PAGE_HINT };
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
