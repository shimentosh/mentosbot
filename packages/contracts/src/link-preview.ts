import * as z from "zod";

/** The longest link a preview is looked up for; longer ones get no card. */
export const LINK_PREVIEW_URL_MAX_LENGTH = 2048;

/**
 * What a page says about itself, read by the server. `image` is a small `data:image/...` URL the
 * server fetched and re-encoded, so a reader's device never contacts the linked site.
 */
export const LinkPreviewSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  image: z.string().nullable(),
});

export type LinkPreview = z.infer<typeof LinkPreviewSchema>;
