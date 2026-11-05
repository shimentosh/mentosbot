import type { LinkPreview } from "@rakazo/contracts";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";

// The server queues and bounds each lookup well inside this, so a slow site resolves to a miss
// on the server instead of an aborted request here.
const LINK_LOOKUP_TIMEOUT_MS = 15_000;

/** A link's site icon from our API, which fetches and caches it; the phone never asks the site. */
export async function loadLinkFavicon(
  origin: string,
  endpoint = currentApiBase(),
): Promise<{ icon: string | null; retry?: boolean }> {
  const requestContext = await captureApiRequestContext();
  if (requestContext.apiBase !== endpoint) throw new Error("Server changed");
  const answer = await rpc(
    "links/favicon",
    { origin },
    { timeoutMs: LINK_LOOKUP_TIMEOUT_MS, requestContext },
  );
  if (currentApiBase() !== endpoint) throw new Error("Server changed");
  return answer;
}

/** A link's preview card from our API, which reads the page and proxies its image. */
export async function loadLinkPreview(
  url: string,
  endpoint = currentApiBase(),
): Promise<{ preview: LinkPreview | null; retry?: boolean }> {
  const requestContext = await captureApiRequestContext();
  if (requestContext.apiBase !== endpoint) throw new Error("Server changed");
  const answer = await rpc(
    "links/preview",
    { url },
    { timeoutMs: LINK_LOOKUP_TIMEOUT_MS, requestContext },
  );
  if (currentApiBase() !== endpoint) throw new Error("Server changed");
  return answer;
}
