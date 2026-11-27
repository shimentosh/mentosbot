// @vitest-environment jsdom

import type { GrantableBot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => <i />,
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    ListSearchInput: ({
      setQuery,
      label,
    }: {
      setQuery: (query: string) => void;
      label: string;
    }) => <input aria-label={label} onChange={(event) => setQuery(event.target.value)} />,
    OptionSelect: () => null,
  };
});

import { BotAccessList } from "./bot-access-list";

function bot(name: string, spaceName = "Home"): GrantableBot {
  return { id: name, name, color: "blue", avatarSet: "organic", spaceName, level: null };
}

it("gives every bot the search shows the same access at once, leaving the rest alone", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChange = vi.fn();
  const bots = ["Writer", "Researcher", "Poster", "Mailer", "Planner", "Reviewer", "Wrangler"].map(
    (name) => bot(name),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <BotAccessList bots={bots} levelOf={() => null} personName="Sam" onChange={onChange} />,
      ),
    );
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search bots"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "wr");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const canChat = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Can chat",
    )!;
    await act(async () => canChat.click());
    expect(onChange).toHaveBeenCalledWith([
      { botId: "Writer", level: "chat" },
      { botId: "Wrangler", level: "chat" },
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
