import {
  linkPreviewSite,
  useExternalLinkOpener,
  useLinkFavicon,
  useLinkPreview,
} from "@rakazo/chat-ui/web";
import type { LinkPreview } from "@rakazo/contracts";
import { Card, CardDescription, CardHeader, CardTitle, cn } from "@rakazo/ui-web";
import { Globe } from "lucide-react";
import type { MouseEvent } from "react";
import { useState } from "react";

/** Cards for the links a message shares, drawn once the server has read each page. */
export function LinkPreviewCards({
  urls,
  end = false,
}: {
  urls: readonly string[];
  end?: boolean;
}) {
  if (urls.length === 0) return null;
  return (
    // Each card brings its own spacing, so links that get no card leave no gap.
    <div className={cn("flex flex-col", end && "items-end")}>
      {urls.map((url) => (
        <LinkPreviewCard key={url} url={url} />
      ))}
    </div>
  );
}

function LinkPreviewCard({ url }: { url: string }) {
  const preview = useLinkPreview(url);
  // Nothing is drawn until the page has been read, so a card never pushes the chat around twice.
  return preview ? <LoadedLinkPreviewCard url={url} preview={preview} /> : null;
}

function LoadedLinkPreviewCard({ url, preview }: { url: string; preview: LinkPreview }) {
  const { icon, unusable } = useLinkFavicon(url);
  const { open, dialog } = useExternalLinkOpener();
  const [imageFailed, setImageFailed] = useState(false);
  const openLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    open(url);
  };
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        data-testid="link-preview"
        className="group mt-2 block w-[340px] max-w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={openLink}
        onAuxClick={openLink}
      >
        <Card size="sm" className="gap-0 py-0 transition-colors group-hover:bg-muted">
          {preview.image && !imageFailed ? (
            <img
              src={preview.image}
              alt=""
              draggable={false}
              className="aspect-[1.91/1] w-full border-b border-border object-cover"
              onError={() => setImageFailed(true)}
            />
          ) : null}
          <CardHeader className="gap-0.5 py-3">
            <CardTitle className="line-clamp-2 text-[14.5px] font-semibold" dir="auto">
              {preview.title}
            </CardTitle>
            {preview.description ? (
              <CardDescription className="line-clamp-2 text-[13px] leading-snug" dir="auto">
                {preview.description}
              </CardDescription>
            ) : null}
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
              {icon ? (
                <img
                  src={icon}
                  alt=""
                  draggable={false}
                  className="size-4 shrink-0 rounded-[4px] bg-favicon-plate object-contain p-px"
                  onError={unusable}
                />
              ) : (
                <Globe aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="truncate" dir="auto">
                {linkPreviewSite(url, preview)}
              </span>
            </span>
          </CardHeader>
        </Card>
      </a>
      {dialog}
    </>
  );
}
