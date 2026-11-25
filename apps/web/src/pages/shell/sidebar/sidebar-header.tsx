import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { CheckCheck, PanelLeft, PanelLeftClose, Plus, Search } from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import { WindowChrome } from "../../../components/WindowChrome";
import { desktopBridge, windowChromeKind } from "../../../lib/platform/desktop";
import { selectedSpaceId } from "../../../lib/query/rpc";
import { useAppRail } from "../app-rail";
import { BotCreatePicker } from "../bots/bot-picker";
import type { Panel } from "../right-panel-state";
import { NotificationBell, useInbox } from "./notification-bell";

// A size class, since the Button sizes any svg without one to 16px.
const ICON = "size-4";
const TOGGLE_ICON = `${ICON} rtl:rotate-180`;
const STROKE = 1.75;

export function SidebarHeader({
  mini = false,
  createMenuOpen,
  setCreateMenuOpen,
  openApprovals,
  searchOpen = false,
  onSearch,
  setBotsSidebarCollapsedPref,
  bots,
  setMobileSidebarOpen,
  setPanel,
  navigate,
  setNewSpaceOpen,
  openAgentImport,
  setCreateBotOpen,
  openSpaceChat,
}: {
  mini?: boolean;
  createMenuOpen: boolean;
  setCreateMenuOpen: (open: boolean) => void;
  openApprovals: () => void;
  searchOpen?: boolean;
  onSearch?: () => void;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  bots: Bot[];
  setMobileSidebarOpen: (open: boolean) => void;
  setPanel: (panel: Panel) => void;
  navigate: (path: string) => void;
  setNewSpaceOpen: (open: boolean) => void;
  openAgentImport: () => void;
  setCreateBotOpen: (open: boolean) => void;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t } = useLingui();
  const hasWindowChrome = Boolean(desktopBridge());
  // The rail holds the window controls from md up; the phone drawer still needs them.
  const rail = useAppRail();
  const toggleLabel = mini ? t`Show bots` : t`Minimize bots`;
  const waiting = useInbox().data?.needsYou.length ?? 0;
  const approvalsLabel = waiting ? t`Approvals, ${waiting} waiting` : t`Approvals`;
  // In the icon rail the actions stack, so a label above or below covers its neighbour.
  const labelSide = mini ? "inline-end" : undefined;
  // In the rail the buttons share the bot tiles' box, so hover shapes line up. Elsewhere they
  // float like the chat header's.
  const railTile = mini ? "size-12 rounded-xl text-muted-foreground" : "";
  // Beside the macOS traffic lights the toggle keeps the spot it has in the open sidebar.
  const pinnedToggle = windowChromeKind(desktopBridge()) === "darwin" && !rail;
  const toggle = (
    <IconTooltip label={toggleLabel} side={labelSide}>
      <Button
        variant={mini && !pinnedToggle ? "ghost" : "floating"}
        size="icon"
        className={`app-no-drag hidden md:inline-flex ${mini && pinnedToggle ? "fixed start-23 top-2.5 z-20" : railTile}`}
        aria-label={toggleLabel}
        data-testid={mini ? "restore-bots-sidebar" : "minimize-bots-sidebar"}
        onClick={() => setBotsSidebarCollapsedPref(!mini)}
      >
        {mini ? (
          <PanelLeft className={TOGGLE_ICON} strokeWidth={STROKE} aria-hidden="true" />
        ) : (
          <PanelLeftClose className={TOGGLE_ICON} strokeWidth={STROKE} aria-hidden="true" />
        )}
      </Button>
    </IconTooltip>
  );
  return (
    <div
      className={`app-drag flex items-center ${mini ? `flex-col gap-1 px-0 pb-3 ${hasWindowChrome && !rail ? "pt-5" : "pt-2"}` : "justify-between px-3 pt-2.5 pb-3"}`}
    >
      <div className={`flex items-center ${mini ? "flex-col gap-2" : "gap-2"}`}>
        {hasWindowChrome ? <WindowChrome className={rail ? "md:hidden" : undefined} /> : null}
        {toggle}
      </div>
      {/* Fits beside the macOS window controls at the narrowest sidebar width. */}
      <div className={`relative flex items-center gap-1 ${mini ? "flex-col" : ""}`}>
        {onSearch && !mini ? (
          <IconTooltip label={t`Search`} side={labelSide}>
            <Button
              variant="floating"
              size="icon"
              aria-label={t`Search`}
              aria-pressed={searchOpen}
              data-testid="sidebar-search-trigger"
              onClick={onSearch}
              className="app-no-drag"
            >
              <Search className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </Button>
          </IconTooltip>
        ) : null}
        <NotificationBell
          bots={bots}
          onOpenChat={(spaceId, path) => {
            setMobileSidebarOpen(false);
            if (spaceId === selectedSpaceId()) navigate(path);
            else openSpaceChat(spaceId, path);
          }}
          onShowAll={openApprovals}
          tooltipSide={labelSide}
          variant={mini ? "ghost" : "floating"}
          className={railTile}
        />
        <IconTooltip label={t`Approvals`} side={labelSide}>
          <Button
            variant={mini ? "ghost" : "floating"}
            size="icon"
            aria-label={approvalsLabel}
            data-testid="approvals-trigger"
            onClick={openApprovals}
            className={`app-no-drag relative ${mini ? "size-12 rounded-xl" : ""} ${waiting ? "text-foreground" : mini ? "text-muted-foreground" : ""}`}
          >
            <CheckCheck className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            {waiting ? (
              <span
                aria-hidden="true"
                // off-scale: a count badge inside a 16px dot.
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground"
              >
                {waiting > 9 ? "9+" : waiting}
              </span>
            ) : null}
          </Button>
        </IconTooltip>
        <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <IconTooltip label={t`Create`} side={labelSide}>
            <PopoverTrigger
              render={
                <Button
                  variant={mini ? "ghost" : "floating"}
                  size="icon"
                  className={`app-no-drag ${railTile}`}
                />
              }
              aria-label={t`Create`}
              data-testid="create-menu-trigger"
            >
              <Plus className={ICON} strokeWidth={STROKE} aria-hidden="true" />
            </PopoverTrigger>
          </IconTooltip>
          {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
          {createMenuOpen ? (
            <PopoverContent
              align="end"
              className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
            >
              <BotCreatePicker
                bots={bots}
                onCreateBot={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setCreateBotOpen(true);
                }}
                onImportAgent={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  openAgentImport();
                }}
                onOpenBot={(id) => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  navigate(`/app/${id}`);
                }}
                onCreateGroup={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setPanel("create-group");
                }}
                onCreateSpace={() => {
                  setCreateMenuOpen(false);
                  setMobileSidebarOpen(false);
                  setNewSpaceOpen(true);
                }}
              />
            </PopoverContent>
          ) : null}
        </Popover>
      </div>
    </div>
  );
}
