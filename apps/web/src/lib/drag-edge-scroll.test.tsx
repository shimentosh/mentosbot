// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edgeScrollStep, useDragEdgeScroll } from "./drag-edge-scroll";

describe("edgeScrollStep", () => {
  it("scrolls faster the closer the pointer is to an edge, and not in the middle", () => {
    expect(edgeScrollStep(300, 0, 600)).toBe(0);
    expect(edgeScrollStep(560, 0, 600)).toBeGreaterThan(0);
    expect(edgeScrollStep(590, 0, 600)).toBeGreaterThan(edgeScrollStep(560, 0, 600));
    expect(edgeScrollStep(10, 0, 600)).toBeLessThan(0);
    // Past the edge, over the footer or header, it scrolls at full speed.
    expect(edgeScrollStep(700, 0, 600)).toBe(16);
    expect(edgeScrollStep(-50, 0, 600)).toBe(-16);
  });

  it("keeps the middle of a short list still", () => {
    expect(edgeScrollStep(50, 0, 100)).toBe(0);
    expect(edgeScrollStep(0, 0, 0)).toBe(0);
  });
});

describe("useDragEdgeScroll", () => {
  let frames: FrameRequestCallback[];
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let list: HTMLDivElement;

  function List() {
    const ref = useRef<HTMLDivElement>(null);
    useDragEdgeScroll(ref);
    return (
      <div ref={ref} data-testid="list">
        <div draggable data-testid="row" />
      </div>
    );
  }

  function drag(type: string, target: EventTarget, clientY = 0) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 100, clientY }));
  }

  function runFrames(count: number) {
    for (let index = 0; index < count; index += 1) frames.shift()?.(performance.now());
  }

  beforeEach(async () => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<List />));
    list = host.querySelector<HTMLDivElement>('[data-testid="list"]')!;
    list.getBoundingClientRect = () =>
      ({ top: 0, bottom: 600, left: 0, right: 300, height: 600, width: 300 }) as DOMRect;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("scrolls the list while a row is dragged near its bottom edge, then stops", () => {
    drag("dragstart", host.querySelector('[data-testid="row"]')!);
    drag("dragover", document, 595);
    runFrames(3);
    expect(list.scrollTop).toBeGreaterThan(0);
    const scrolled = list.scrollTop;

    drag("dragover", document, 300);
    runFrames(3);
    expect(list.scrollTop).toBe(scrolled);

    drag("dragover", document, 595);
    drag("dragend", document);
    runFrames(3);
    expect(list.scrollTop).toBe(scrolled);
  });

  it("ignores drags that did not start in the list", () => {
    drag("dragover", document, 595);
    runFrames(3);
    expect(list.scrollTop).toBe(0);
  });
});
