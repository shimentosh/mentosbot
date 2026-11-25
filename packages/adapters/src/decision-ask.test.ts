import type { DecisionProvider, DecisionRequest } from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  ASK_DECISION_RUBRIC_VERSION,
  askDecisionEligible,
  decideAskForOwner,
} from "./decision-ask.js";

const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const ask = {
  text: "Which format should the report use?",
  actions: [
    { id: "choice-1", label: "PDF" },
    { id: "choice-2", label: "Google Doc" },
  ],
};

function provider(
  answer: { choice: string; confidence?: number; probabilities?: Record<string, number> } | Error,
) {
  const decide = vi.fn(async (request: DecisionRequest) => {
    if (answer instanceof Error) throw answer;
    return { model: request.model, answers: { answer: { type: "choice" as const, ...answer } } };
  });
  return { provider: { decide } satisfies DecisionProvider, decide };
}

const decide = (
  p: DecisionProvider,
  input: Partial<{ ask: typeof ask; ownerRequest: string }> = {},
) =>
  decideAskForOwner(
    p,
    "jev",
    {
      ask: input.ask ?? ask,
      ownerRequest: input.ownerRequest ?? "Send me the report as a PDF.",
      bot: "Analyst",
    },
    context,
  );

describe("askDecisionEligible", () => {
  it("takes only a plain one-of-several question", () => {
    expect(askDecisionEligible(ask)).toBe(true);
    expect(askDecisionEligible({ ...ask, actions: ask.actions.slice(0, 1) })).toBe(false);
    expect(askDecisionEligible({ ...ask, multiple: true })).toBe(false);
    expect(askDecisionEligible({ ...ask, preview: "Draft post" })).toBe(false);
    expect(askDecisionEligible({ ...ask, previewImages: ["artifact"] })).toBe(false);
    expect(askDecisionEligible({ text: "Your name?" })).toBe(false);
  });
});

describe("decideAskForOwner", () => {
  it("picks the option the model is sure of and asks with the versioned rubric", async () => {
    const fake = provider({ choice: "choice-1", probabilities: { "choice-1": 0.92 } });
    await expect(decide(fake.provider)).resolves.toBe("choice-1");
    const request = fake.decide.mock.calls[0]![0];
    expect(request.state).toMatchObject({
      rubricVersion: ASK_DECISION_RUBRIC_VERSION,
      ownerRequest: "Send me the report as a PDF.",
      question: ask.text,
    });
    expect(Object.keys(request.questions.answer!.criteria)).toEqual([
      "choice-1",
      "choice-2",
      "owner_decides",
    ]);
  });

  it("leaves the question to the owner when the model defers or is unsure", async () => {
    await expect(
      decide(
        provider({ choice: "owner_decides", probabilities: { owner_decides: 0.99 } }).provider,
      ),
    ).resolves.toBeNull();
    await expect(
      decide(provider({ choice: "choice-2", probabilities: { "choice-2": 0.6 } }).provider),
    ).resolves.toBeNull();
    await expect(decide(provider({ choice: "choice-2" }).provider)).resolves.toBeNull();
  });

  it("falls back to confidence when no probabilities come back", async () => {
    await expect(decide(provider({ choice: "choice-2", confidence: 0.85 }).provider)).resolves.toBe(
      "choice-2",
    );
  });

  it("never answers with an option the bot did not offer", async () => {
    await expect(
      decide(provider({ choice: "choice-9", probabilities: { "choice-9": 1 } }).provider),
    ).resolves.toBeNull();
  });

  it("leaves the question to the owner when the provider fails", async () => {
    await expect(
      decide(provider(new DecisionProviderError("unavailable")).provider),
    ).resolves.toBeNull();
  });

  it("does not call the provider for a question it cannot answer", async () => {
    const fake = provider({ choice: "choice-1", probabilities: { "choice-1": 1 } });
    await expect(
      decide(fake.provider, { ask: { ...ask, multiple: true } as typeof ask }),
    ).resolves.toBeNull();
    expect(fake.decide).not.toHaveBeenCalled();
  });
});
