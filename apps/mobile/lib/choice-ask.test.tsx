// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Alert: { alert: vi.fn() },
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Text: ({ children, style }: { children?: ReactNode; style?: { color?: string } }) =>
      createElement("span", { "data-color": style?.color }, children),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      value: string;
      onChangeText: (value: string) => void;
      onSubmitEditing?: () => void;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        onKeyDown: (event: { key: string }) => event.key === "Enter" && onSubmitEditing?.(),
      }),
  };
});

vi.mock("./native", () => ({
  useMobileTokens: () => ({
    success: "success",
    mutedForeground: "muted",
    destructive: "destructive",
    foreground: "foreground",
  }),
}));

vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? ""),
  }),
}));

vi.mock("../components/native-action-button", async () => {
  const { createElement } = await import("react");
  return {
    NativeActionButton: ({
      label,
      onPress,
      disabled,
      busy,
      prominence = "primary",
      selected,
    }: {
      label: string;
      onPress: () => void;
      disabled?: boolean;
      busy?: boolean;
      prominence?: string;
      selected?: boolean;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled: disabled || busy,
          "data-prominence": prominence,
          "aria-pressed": selected,
        },
        label,
      ),
  };
});

import { ChoiceAskActions } from "../components/ChoiceAskActions";

type Ask = Extract<MessageBlock, { kind: "ask" }>;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const draft: Ask = {
  kind: "ask",
  text: "Post this?",
  status: "pending",
  preview: "Hello\nworld",
  previewLimit: 12,
  actions: [
    { id: "choice-1", label: "Post" },
    { id: "choice-2", label: "Not now" },
  ],
};

async function render(block: Ask, onAnswer: (answer: string) => Promise<void>) {
  await act(async () =>
    root.render(<ChoiceAskActions block={block} canAnswer onAnswer={onAnswer} />),
  );
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}

async function type(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("approves a draft from a row of native buttons, the first one primary", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(draft, onAnswer);

  expect(container.textContent).toContain("Hello\nworld");
  expect(container.textContent).toContain("11/12");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Post",
    "Edit",
    "Not now",
  ]);
  expect(button("Post")!.dataset.prominence).toBe("primary");
  await act(async () => button("Post")!.click());
  expect(onAnswer).toHaveBeenCalledWith("choice-1");
});

it("sends an edited draft, and holds the options while it is over the limit", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(draft, onAnswer);

  await act(async () => button("Edit")!.click());
  await type("Draft", "This is far too long");
  expect(container.querySelector('[data-color="destructive"]')?.textContent).toBe("20/12");
  expect(button("Post")!.disabled).toBe(true);

  await type("Draft", "Hi there");
  await act(async () => button("Not now")!.click());
  expect(onAnswer).toHaveBeenCalledWith(
    JSON.stringify({ choices: ["choice-2"], edited: "Hi there" }),
  );
});

it("shows an answered draft's final text and choice", async () => {
  await render(
    {
      ...draft,
      status: "answered",
      answer: "choice-1",
      answers: ["choice-1"],
      editedPreview: "Edited",
    },
    async () => undefined,
  );
  expect(container.textContent).toContain("Edited");
  expect(container.textContent).toContain("Answered: Post");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("latches multi-select options and confirms them once with an own answer", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(
    {
      kind: "ask",
      text: "Which platforms?",
      status: "pending",
      multiple: true,
      other: true,
      actions: [
        { id: "choice-1", label: "Blog" },
        { id: "choice-2", label: "Newsletter" },
      ],
    },
    onAnswer,
  );

  expect(button("Done")!.disabled).toBe(true);
  await act(async () => button("Newsletter")!.click());
  expect(button("Newsletter")!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("Other…")!.click());
  await type("Answer", " Podcast ");
  await act(async () => button("Done")!.click());
  expect(onAnswer).toHaveBeenCalledWith(
    JSON.stringify({ choices: ["choice-2"], other: "Podcast" }),
  );
});
