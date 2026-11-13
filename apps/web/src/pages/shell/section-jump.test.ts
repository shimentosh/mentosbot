import { describe, expect, it, vi } from "vitest";
import { currentSection } from "./section-jump";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String }) }));

describe("currentSection", () => {
  it("leaves the bar hidden while the first header is on screen", () => {
    expect(
      currentSection([
        { key: "a", top: 0 },
        { key: "b", top: 300 },
      ]),
    ).toEqual({ key: "a", pinned: false });
  });

  it("pins the section whose header has scrolled away", () => {
    expect(
      currentSection([
        { key: "a", top: -400 },
        { key: "b", top: -120 },
        { key: "c", top: 200 },
      ]),
    ).toEqual({ key: "b", pinned: true });
  });

  it("hands over to the next header once it reaches the bar", () => {
    expect(
      currentSection([
        { key: "a", top: -400 },
        { key: "b", top: 20 },
      ]),
    ).toEqual({ key: "b", pinned: false });
  });

  it("has no section before the first header reaches the top", () => {
    expect(currentSection([{ key: "a", top: 80 }])).toBeNull();
  });
});
