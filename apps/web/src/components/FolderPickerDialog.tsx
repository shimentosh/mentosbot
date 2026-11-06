import { Trans, useLingui } from "@lingui/react/macro";
import type { FolderListing } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, Folder, FolderCode } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** The folder as the person reads it: `~` for their home. */
export function homeRelative(listing: Pick<FolderListing, "home" | "path">) {
  if (listing.path === listing.home) return "~";
  return listing.path.startsWith(`${listing.home}/`) || listing.path.startsWith(`${listing.home}\\`)
    ? `~${listing.path.slice(listing.home.length)}`
    : listing.path;
}

/**
 * Browses the folders on the person's own computer through its desktop app and picks one.
 * Projects are marked, and one press opens a folder or uses a project.
 */
export function FolderPickerDialog({
  botId,
  onPick,
  onCancel,
}: {
  /** The bot the folder is for; a bot still being created has none yet. */
  botId?: string;
  onPick: (path: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(path?: string) {
    setLoading(true);
    setError(null);
    try {
      setListing(await rpc.projectFolder.browse({ ...(botId ? { botId } : {}), path }));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function pick(path: string) {
    setPicking(true);
    setError(null);
    try {
      await onPick(path);
    } catch (reason) {
      setError(errorText(reason));
      setPicking(false);
    }
  }

  useEffect(() => {
    void open();
  }, []);

  const join = (name: string) =>
    listing ? `${listing.path}${listing.path.includes("\\") ? "\\" : "/"}${name}` : name;

  return (
    <Dialog open onOpenChange={(next) => (next || picking ? undefined : onCancel())}>
      <DialogContent
        className="flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col sm:max-w-md"
        data-testid="folder-picker"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Choose a project folder</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-9 items-center gap-1 text-sm">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Back`}
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void open(listing.parent)}
          >
            <ChevronLeft aria-hidden size={16} />
          </Button>
          <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground">
            {listing ? homeRelative(listing) : "~"}
          </span>
        </div>
        <div className="-mx-2 min-h-40 flex-1 overflow-y-auto">
          {loading ? (
            <div className="grid h-40 place-items-center">
              <Spinner />
            </div>
          ) : listing && listing.folders.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              <Trans>No folders here</Trans>
            </p>
          ) : (
            listing?.folders.map((folder) => (
              <div
                key={folder.name}
                className="group flex min-h-10 items-center gap-2 rounded-lg px-2 hover:bg-muted/60"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-start text-sm"
                  onClick={() => void open(join(folder.name))}
                >
                  {folder.project ? (
                    <FolderCode aria-hidden size={16} className="shrink-0 text-foreground" />
                  ) : (
                    <Folder aria-hidden size={16} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{folder.name}</span>
                </button>
                {folder.project ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={picking}
                    onClick={() => void pick(join(folder.name))}
                  >
                    <Trans>Use</Trans>
                  </Button>
                ) : (
                  <ChevronRight aria-hidden size={15} className="text-muted-foreground" />
                )}
              </div>
            ))
          )}
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={picking} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!listing?.parent || loading || picking}
            onClick={() => listing && void pick(listing.path)}
          >
            <Trans>Use this folder</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
