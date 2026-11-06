// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MonthView } from "./calendar.js";
import { Table } from "./data.js";
import { EmptyChart } from "./dataviz.js";
import { PageLanguage, wordsFor } from "./labels.js";
import { Page } from "./layout.js";
import { Gallery } from "./media.js";
import "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

function mount(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const longRows = Array.from({ length: 250 }, (_, index) => [`Row ${index}`, index * 1000]);

describe("page words", () => {
  it("are English, with plural forms", () => {
    const words = wordsFor("ru");
    expect(words.locale).toBe("en");
    expect(words.t("photos", { count: 1 })).toBe("1 photo");
    expect(words.t("photos", { count: 2 })).toBe("2 photos");
    expect(wordsFor("not a tag").number(1234.5)).toBe("1,234.5");
  });

  it("keep English and US formats for a page with no language", () => {
    const root = mount(
      <Page title="Report">
        <Table columns={["Name", "Value"]} rows={longRows} />
        <EmptyChart />
      </Page>,
    );
    expect(root.querySelector("input")!.placeholder).toBe("Filter rows");
    expect(root.querySelector(".rk-table-more span")!.textContent).toBe("Showing 200 of 250");
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("No data");
    expect(root.querySelector("main")!.hasAttribute("dir")).toBe(false);
  });

  it("write dates and numbers the page's language's way, with English words", () => {
    const root = mount(
      <Page title="Rapport" lang="fr">
        <Table columns={["Nom", "Valeur"]} rows={longRows} />
        <MonthView month="2026-10" />
        <EmptyChart />
      </Page>,
    );
    expect(root.querySelector("input")!.placeholder).toBe("Filter rows");
    expect(root.querySelector(".rk-cal-month")!.getAttribute("aria-label")).toBe("octobre 2026");
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("No data");
    expect(document.documentElement.lang).toBe("fr");
    expect(wordsFor("pl-PL").number(1234.5)).toBe(new Intl.NumberFormat("pl-PL").format(1234.5));
  });

  it("keep English words whatever language the reader's app gives the frame", () => {
    const reader = mount(
      <PageLanguage.Provider value="he">
        <Page title="Report">
          <EmptyChart />
        </Page>
      </PageLanguage.Provider>,
    );
    expect(reader.querySelector(".rk-chart-empty")!.textContent).toBe("No data");
    // The reader's language says nothing about the content, so the page keeps its direction.
    expect(reader.querySelector("main")!.hasAttribute("dir")).toBe(false);
  });

  it("lays a right-to-left page out right to left", () => {
    const root = mount(
      <Page title="דוח" lang="he">
        <Gallery photos={[{ src: PIXEL }, { src: PIXEL }]} />
      </Page>,
    );
    expect(root.querySelector("main")!.getAttribute("dir")).toBe("rtl");
    expect(document.documentElement.dir).toBe("rtl");
    expect(root.querySelector(".rk-gallery")!.getAttribute("aria-label")).toBe("2 photos");
    expect(wordsFor("en").dir).toBe("ltr");
  });
});
