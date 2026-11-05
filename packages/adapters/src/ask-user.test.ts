import { describe, expect, it } from "vitest";
import { askUserRequest } from "./ask-user.js";

describe("askUserRequest", () => {
  it("keeps a plain question as it always was", () => {
    expect(askUserRequest({ question: "Which city?", options: [" Berlin ", "Seoul"] })).toEqual({
      question: "Which city?",
      options: ["Berlin", "Seoul"],
    });
  });

  it("carries a draft, its limit and the multi-select and own-answer flags", () => {
    expect(
      askUserRequest({
        question: "Post this?",
        options: ["Post", "Not now"],
        preview: "Line one\nLine two",
        limit: 280,
        other: true,
      }),
    ).toEqual({
      question: "Post this?",
      options: ["Post", "Not now"],
      preview: "Line one\nLine two",
      previewLimit: 280,
      other: true,
    });
    expect(
      askUserRequest({
        question: "Which platforms?",
        options: ["A", "B", "C", "D", "E", "F"],
        multiple: true,
        other: false,
      }),
    ).toEqual({
      question: "Which platforms?",
      options: ["A", "B", "C", "D", "E", "F"],
      multiple: true,
    });
  });

  it("allows more than four options only on a multi-select question", () => {
    const options = ["A", "B", "C", "D", "E"];
    expect(() => askUserRequest({ question: "Pick", options })).toThrow(
      "ask_user requires two to four unique, non-empty options",
    );
    expect(() =>
      askUserRequest({ question: "Pick", options: [...options, "F", "G"], multiple: true }),
    ).toThrow("ask_user with multiple requires two to six unique, non-empty options");
    expect(() => askUserRequest({ question: "Pick", options: ["A", "A"] })).toThrow();
    expect(() => askUserRequest({ question: "Pick", options: ["A", "x".repeat(81)] })).toThrow();
  });

  it("rejects a draft over its limit, counting an emoji as one character", () => {
    expect(
      askUserRequest({ question: "Post?", options: ["Post", "No"], preview: "👋👋👋", limit: 3 })
        .previewLimit,
    ).toBe(3);
    expect(() =>
      askUserRequest({ question: "Post?", options: ["Post", "No"], preview: "abcd", limit: 3 }),
    ).toThrow("ask_user preview is 4 characters, over its limit of 3; shorten it and ask again");
  });

  it("rejects a malformed draft, limit, flag or question", () => {
    const base = { question: "Post?", options: ["Post", "No"] };
    expect(() => askUserRequest({ ...base, preview: "  " })).toThrow();
    expect(() => askUserRequest({ ...base, preview: "x".repeat(4001) })).toThrow();
    expect(() => askUserRequest({ ...base, limit: 280 })).toThrow("ask_user limit needs a preview");
    expect(() => askUserRequest({ ...base, preview: "Hi", limit: 2.5 })).toThrow();
    expect(() => askUserRequest({ ...base, preview: "Hi", limit: 0 })).toThrow();
    expect(() => askUserRequest({ ...base, multiple: "yes" })).toThrow();
    expect(() => askUserRequest({ ...base, question: "x".repeat(241) })).toThrow();
  });
});
