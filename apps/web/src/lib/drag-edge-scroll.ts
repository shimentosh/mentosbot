import type { RefObject } from "react";
import { useEffect } from "react";

/** Distance from the list's top or bottom edge where a drag starts scrolling it. */
const EDGE_PX = 56;
/** Fastest scroll, in pixels per frame, once the pointer reaches or passes the edge. */
const MAX_STEP_PX = 16;
/**
 * Browsers fire `dragover` repeatedly even while the pointer rests, so a longer gap means the
 * drag left the window or ended without reaching us.
 */
const STALE_MS = 500;

/** Pixels to scroll this frame for a pointer at `y` over a list spanning `top`..`bottom`. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  const zone = Math.min(EDGE_PX, (bottom - top) / 4);
  if (zone <= 0) return 0;
  const speed = (depth: number) => Math.ceil(Math.min(1, depth / zone) * MAX_STEP_PX);
  if (y < top + zone) return -speed(top + zone - y);
  if (y > bottom - zone) return speed(y - (bottom - zone));
  return 0;
}

/**
 * While something dragged from inside `ref` is held near the list's top or bottom edge, or past
 * it over the header or footer, scrolls the list so a drop target out of view can be reached.
 */
export function useDragEdgeScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    let step = 0;
    let lastOver = 0;
    let frame = 0;
    const tick = () => {
      frame = 0;
      if (!step || performance.now() - lastOver > STALE_MS) return;
      list.scrollTop += step;
      frame = requestAnimationFrame(tick);
    };
    const over = (event: DragEvent) => {
      const rect = list.getBoundingClientRect();
      lastOver = performance.now();
      step =
        event.clientX < rect.left || event.clientX > rect.right
          ? 0
          : edgeScrollStep(event.clientY, rect.top, rect.bottom);
      if (step && !frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      step = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragend", stop);
      document.removeEventListener("drop", stop);
    };
    const start = () => {
      stop();
      document.addEventListener("dragover", over);
      document.addEventListener("dragend", stop);
      document.addEventListener("drop", stop);
    };
    list.addEventListener("dragstart", start);
    return () => {
      list.removeEventListener("dragstart", start);
      stop();
    };
  }, [ref]);
}
