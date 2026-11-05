import { useLingui } from "@lingui/react/macro";
import type { Bot, BotSection } from "@rakazo/contracts";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@rakazo/ui-web";
import {
  Archive,
  Bell,
  BellDot,
  Check,
  Copy,
  Eraser,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  Trash2,
  X,
} from "lucide-react";
import { useQueryUserId } from "../lib/query";
import { rpc } from "../lib/rpc";

type ChatMenuTarget = Pick<Bot, "name" | "pinned" | "sectionId" | "unread"> &
  Partial<Pick<Bot, "id" | "share">>;

/** A roster row's context menu content; `onClose` serves the lazy-load error fallback. */
export function BotContextMenu({
  bot,
  onTogglePinned,
  sections,
  onMoveToSection,
  onCreateSection,
  onRenameSection,
  onToggleUnread,
  onEdit,
  onDuplicate,
  onClear,
  onArchive,
  onDelete,
}: {
  bot: ChatMenuTarget;
  onClose: () => void;
  onTogglePinned: () => void;
  sections: BotSection[];
  onMoveToSection: (sectionId: string | null) => void;
  onCreateSection: () => void;
  onRenameSection?: (sectionId: string) => void;
  onToggleUnread: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onClear: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const userId = useQueryUserId();

  // A teammate's bot: its sidebar place, profile and lifecycle stay its owner's.
  if (bot.share && bot.id) {
    const botId = bot.id;
    return (
      <ContextMenuContent aria-label={t`Actions for ${bot.name}`} className="w-[264px]">
        <ContextMenuItem onClick={onToggleUnread}>
          {bot.unread ? <BellDot /> : <Bell />}
          {bot.unread ? t`Mark as Read` : t`Mark as Unread`}
        </ContextMenuItem>
        {bot.share.level === "manage" ? (
          <ContextMenuItem onClick={onEdit}>
            <Pencil />
            {t`Edit Profile`}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() =>
            void rpc.team
              .unshareBot({ botId, userId: userId ?? "" })
              .then(() => window.location.assign("/app"))
          }
        >
          <X />
          {t`Remove from my list`}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  return (
    <ContextMenuContent
      aria-label={t`Actions for ${bot.name}`}
      className="max-h-[min(420px,calc(100vh-16px))] w-[264px] overflow-y-auto"
    >
      <ContextMenuItem onClick={onTogglePinned}>
        <Pin />
        {bot.pinned ? t`Unpin` : t`Pin`}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Folder />
          {t`Move to`}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="max-h-[min(420px,calc(100vh-16px))] min-w-[180px] overflow-y-auto">
          {sections.map((section) => (
            <ContextMenuItem key={section.id} onClick={() => onMoveToSection(section.id)}>
              <Folder />
              <span dir="auto">{section.name}</span>
              {bot.sectionId === section.id ? <Check className="ms-auto" /> : null}
            </ContextMenuItem>
          ))}
          <ContextMenuItem onClick={() => onMoveToSection(null)}>
            <Folder />
            {t`Unassigned`}
            {bot.sectionId === null ? <Check className="ms-auto" /> : null}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onCreateSection}>
            <FolderPlus />
            {t`New section`}
          </ContextMenuItem>
          {bot.sectionId && onRenameSection ? (
            <ContextMenuItem onClick={() => onRenameSection(bot.sectionId!)}>
              <Pencil />
              {t`Rename section`}
            </ContextMenuItem>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onClick={onToggleUnread}>
        {bot.unread ? <BellDot /> : <Bell />}
        {bot.unread ? t`Mark as Read` : t`Mark as Unread`}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onEdit}>
        <Pencil />
        {t`Edit Profile`}
      </ContextMenuItem>
      <ContextMenuItem onClick={onDuplicate}>
        <Copy />
        {t`Duplicate`}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onClear}>
        <Eraser />
        {t`Clear conversation`}
      </ContextMenuItem>
      <ContextMenuItem onClick={onArchive}>
        <Archive />
        {t`Archive`}
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        {t`Delete`}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
