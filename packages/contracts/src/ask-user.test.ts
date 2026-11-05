import { describe, expect, it } from "vitest";
import { askTextLength, encodeAskChoiceAnswer, parseAskChoiceAnswer } from "./ask-user.js";
import { MessageBlock } from "./events.js";

describe("choice question blocks", () => {
  it("still reads a question saved before drafts, multi-select and own answers", () => {
    const saved = {
      kind: "ask",
      text: "Which city?",
      status: "answered",
      answer: "choice-2",
      actions: [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ],
    };
    expect(MessageBlock.parse(saved)).toEqual(saved);
  });

  it("keeps a draft question's fields and its answer", () => {
    const block = {
      kind: "ask",
      text: "Post this?",
      preview: "Hello\nworld",
      previewLimit: 280,
      multiple: true,
      other: true,
      status: "answered",
      answer: "Post, Later",
      answers: ["choice-1"],
      otherAnswer: "Later",
      editedPreview: "Hello there",
      actions: [
        { id: "choice-1", label: "Post" },
        { id: "choice-2", label: "Not now" },
      ],
    };
    expect(MessageBlock.parse(block)).toEqual(block);
    expect(MessageBlock.safeParse({ ...block, previewLimit: 0 }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...block, multiple: false }).success).toBe(false);
  });
});

describe("choice card answers", () => {
  it("sends a lone choice as its bare id, which every server accepts", () => {
    expect(encodeAskChoiceAnswer({ choices: ["choice-1"] })).toBe("choice-1");
    expect(parseAskChoiceAnswer("choice-1")).toBeUndefined();
  });

  it("round-trips several choices, an own answer and an edited draft", () => {
    for (const answer of [
      { choices: ["choice-1", "choice-3"] },
      { choices: [], other: "Podcast" },
      { choices: ["choice-1"], edited: "Hello\nthere" },
    ]) {
      const encoded = encodeAskChoiceAnswer(answer);
      expect(encoded.startsWith("{")).toBe(true);
      expect(parseAskChoiceAnswer(encoded)).toEqual(answer);
    }
  });

  it("reads anything else as a typed reply", () => {
    for (const typed of [
      "Toronto",
      "{not json",
      "[]",
      '{"choices":"choice-1"}',
      '{"choices":[1]}',
      '{"choices":[],"other":3}',
      '{"choices":[],"extra":true}',
    ])
      expect(parseAskChoiceAnswer(typed)).toBeUndefined();
  });

  it("counts characters the way people do", () => {
    expect(askTextLength("hi 👋")).toBe(4);
  });
});
