import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
  newBotLook,
  newBotLookInput,
  newBotPreviewIdentity,
  ORGANIC_PREVIEW_IDENTITIES,
} from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { FolderCode, X } from "lucide-react";
import { useRef, useState } from "react";
import { FolderPickerDialog } from "../../components/FolderPickerDialog";
import { desktopBridge, thisComputer } from "../../lib/desktop";
import { errorText } from "../../lib/user-error";
import { BotLookPicker } from "./avatar-studio-popover";

export interface CreateBotDialogInput {
  name: string;
  color: string;
  /** Reserve the logo preview's persistent seed through creation and retries. */
  id?: string;
  /** The organic family the preview drew; omitted when a studio shape is picked. */
  avatarFamily?: number;
  /** A folder on the person's computer the new bot works in; `deviceId` names this computer. */
  projectFolder?: { path: string; deviceId?: string };
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  avatarSet,
  onCancel,
  onCreate,
}: {
  /** The account's set: the server gives it to the new bot, so the preview draws it too. */
  avatarSet: BotAvatarSet;
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [look, setLook] = useState(newBotLook);
  const identity = newBotPreviewIdentity(avatarSet, look);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFolder, setProjectFolder] = useState<CreateBotDialogInput["projectFolder"]>();
  const [pickingFolder, setPickingFolder] = useState(false);
  const trimmed = name.trim();

  function takeFolder(folder: NonNullable<CreateBotDialogInput["projectFolder"]>) {
    setProjectFolder(folder);
    if (!trimmed) setName(folderName(folder.path).slice(0, BOT_NAME_MAX_LENGTH));
  }

  async function chooseFolder() {
    const computer = await thisComputer();
    if (!computer?.chooseFolder) return setPickingFolder(true);
    const path = await computer.chooseFolder();
    if (path) takeFolder({ path, deviceId: computer.deviceId });
  }

  async function create() {
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onCreate({
        name: trimmed,
        ...newBotLookInput(avatarSet, look),
        ...(projectFolder ? { projectFolder } : {}),
      });
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={nameRef}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-center">
              <Trans>New bot</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <BotAvatar color={look.color} identity={identity} size={96} avatarSet={avatarSet} />
          </div>
          <Input
            ref={nameRef}
            aria-label={t`Name`}
            placeholder={t`Name your Bot`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="text-center"
          />
          {projectFolder ? (
            <div className="flex min-h-9 items-center gap-2 rounded-lg bg-muted/50 ps-3 pe-1 text-body">
              <FolderCode aria-hidden size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{folderName(projectFolder.path)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Remove folder`}
                onClick={() => setProjectFolder(undefined)}
              >
                <X aria-hidden size={14} />
              </Button>
            </div>
          ) : desktopBridge() ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-center text-muted-foreground"
              onClick={() => void chooseFolder()}
            >
              <FolderCode aria-hidden size={15} />
              <Trans>Start from a project folder</Trans>
            </Button>
          ) : null}
          {error ? (
            <p
              role="alert"
              data-testid="create-bot-error"
              className="text-body-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <BotLookPicker
            value={look.color}
            identity={identity}
            organicIdentities={ORGANIC_PREVIEW_IDENTITIES}
            avatarSet={avatarSet}
            onChange={(color, picked) => {
              setLook((current) => ({ ...current, color, identity: picked ?? current.identity }));
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!trimmed || submitting}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
        {pickingFolder ? (
          <FolderPickerDialog
            onCancel={() => setPickingFolder(false)}
            onPick={(path) => {
              takeFolder({ path });
              setPickingFolder(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
