import { useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronsUpDown } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

export type JumpSection = { key: string; title: string };

/** Height of the pinned bar; a header within it counts as scrolled past. */
const BAR_PX = 32;

/**
 * The section being read: the last one whose header has reached the pinned bar.
 * `pinned` is false while that header is still fully on screen, so the bar never repeats it.
 */
export function currentSection(
  headers: readonly { key: string; top: number }[],
): { key: string; pinned: boolean } | null {
  let current: { key: string; top: number } | undefined;
  for (const header of headers) {
    if (header.top > BAR_PX) break;
    current = header;
  }
  return current ? { key: current.key, pinned: current.top < 0 } : null;
}

function sectionElement(list: HTMLElement, key: string) {
  return list.querySelector<HTMLElement>(`[data-sidebar-group="${CSS.escape(key)}"]`);
}

/**
 * Once a section's header scrolls away, pins its name above the bot list; the name opens a
 * menu that scrolls straight to any other section.
 */
export function SectionJump({
  listRef,
  sections,
}: {
  listRef: RefObject<HTMLElement | null>;
  sections: readonly JumpSection[];
}) {
  const { t } = useLingui();
  const [current, setCurrent] = useState<{ key: string; pinned: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const focusAfterJump = useRef<HTMLElement | null>(null);
  const keys = sections.map((section) => section.key).join("\n");

  useEffect(() => {
    const list = listRef.current;
    if (!list || !keys) {
      setCurrent(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const listTop = list.getBoundingClientRect().top;
      const headers = keys.split("\n").flatMap((key) => {
        const element = sectionElement(list, key);
        return element ? [{ key, top: element.getBoundingClientRect().top - listTop }] : [];
      });
      const next = currentSection(headers);
      setCurrent((previous) =>
        previous?.key === next?.key && previous?.pinned === next?.pinned ? previous : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    list.addEventListener("scroll", schedule, { passive: true });
    // Collapsing a section or a bot arriving moves the headers without a scroll event.
    const resize = new ResizeObserver(schedule);
    for (const child of Array.from(list.children)) resize.observe(child);
    return () => {
      list.removeEventListener("scroll", schedule);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [listRef, keys]);

  if (sections.length < 2) return null;
  const pinned = Boolean(current?.pinned) || open;
  const title = sections.find((section) => section.key === current?.key)?.title ?? "";

  function jump(key: string) {
    const list = listRef.current;
    const element = list ? sectionElement(list, key) : null;
    if (!list || !element) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({
      top: list.scrollTop + element.getBoundingClientRect().top - list.getBoundingClientRect().top,
      behavior: reduceMotion ? "auto" : "smooth",
    });
    // The bar hides once the header is back on screen, so focus lands on the header itself.
    focusAfterJump.current = element.querySelector<HTMLElement>("[data-sidebar-header]");
  }

  return (
    <div
      data-testid="sidebar-section-jump"
      aria-hidden={pinned ? undefined : true}
      inert={pinned ? undefined : true}
      className={`absolute inset-x-2.5 top-0 z-10 bg-sidebar pb-0.5 transition-opacity duration-150 motion-reduce:transition-none ${
        pinned ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          aria-label={t`Jump to section, ${title}`}
          className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring data-popup-open:bg-sidebar-accent"
        >
          <span className="truncate">{title}</span>
          <ChevronsUpDown size={13} strokeWidth={1.8} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          finalFocus={() => {
            const target = focusAfterJump.current;
            focusAfterJump.current = null;
            if (!target) return true;
            // A plain focus() would scroll instantly and cut the smooth scroll short.
            requestAnimationFrame(() => target.focus({ preventScroll: true }));
            return false;
          }}
        >
          {/* Items jump on click so the current section scrolls back to its own header too. */}
          <DropdownMenuRadioGroup value={current?.key ?? null}>
            {sections.map((section) => (
              <DropdownMenuRadioItem
                key={section.key}
                value={section.key}
                closeOnClick
                onClick={() => jump(section.key)}
              >
                <span className="truncate">{section.title}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
