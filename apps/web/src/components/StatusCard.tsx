import { useLingui } from "@lingui/react/macro";
import { useLinkPrompt } from "@rakazo/chat-ui/web";
import type { CardBlock } from "@rakazo/contracts";
import { cardLinks, cardStatus } from "@rakazo/core";
import { buttonVariants, Card, CardContent, cn } from "@rakazo/ui-web";
import { ArrowUpRight, CircleCheck, CircleX, Clock, Info } from "lucide-react";
import { useRef } from "react";

const STATUS_ICONS = {
  done: { Icon: CircleCheck, className: "text-success" },
  pending: { Icon: Clock, className: "text-warning" },
  failed: { Icon: CircleX, className: "text-destructive" },
  info: { Icon: Info, className: "text-muted-foreground" },
} as const;

/** A receipt or status a bot showed: what happened, a few facts, and links to the result. */
export function StatusCard({ block }: { block: CardBlock & { title: string } }) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const linkDialog = useLinkPrompt(ref);
  const status = cardStatus(block);
  const { Icon, className } = STATUS_ICONS[status];
  const links = cardLinks(block);
  const statusLabel = { done: t`Done`, pending: t`Pending`, failed: t`Failed`, info: undefined }[
    status
  ];
  return (
    <Card ref={ref} size="sm" className="w-80 max-w-full" data-testid="status-card">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Icon
            role={statusLabel ? "img" : undefined}
            aria-label={statusLabel}
            aria-hidden={statusLabel ? undefined : true}
            className={cn("mt-px size-4 shrink-0", className)}
          />
          <span className="min-w-0 font-medium break-words" dir="auto">
            {block.title}
          </span>
        </div>
        {block.lines.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 ps-6">
            {block.lines.map((line, index) => (
              <div key={`${line.k}-${index}`} className="contents">
                <dt className="text-muted-foreground" dir="auto">
                  {line.k}
                </dt>
                <dd className="break-words" dir="auto">
                  {line.v}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {links.length > 0 ? (
          <div className="flex flex-wrap gap-2 ps-6">
            {links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
                dir="auto"
              >
                {link.label}
                <ArrowUpRight aria-hidden data-icon="inline-end" />
              </a>
            ))}
          </div>
        ) : null}
      </CardContent>
      {linkDialog}
    </Card>
  );
}
