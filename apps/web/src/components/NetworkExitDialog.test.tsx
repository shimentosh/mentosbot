// @vitest-environment jsdom
import type { NetworkExitStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NetworkExitDialog } from "./NetworkExitDialog";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Field: Pass,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
  };
});
const { networkExit } = vi.hoisted(() => ({
  networkExit: { get: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({ rpc: { networkExit }, selectedSpaceId: () => "space-1" }));
vi.mock("../lib/query", () => ({
  queryClient: { setQueryData: vi.fn() },
  spaceQueries: () => ({ key: () => ["space"] }),
  useQueryUserId: () => "user-1",
}));

const provider = {
  id: "own",
  displayName: "Own network",
  fields: [
    { key: "authKey", label: "Auth key", kind: "secret" as const, required: true },
    { key: "exitNode", label: "Exit node", kind: "text" as const, required: true },
  ],
};
const disconnected: NetworkExitStatus = { providers: [provider], connection: null };
const connected: NetworkExitStatus = {
  providers: [provider],
  connection: {
    provider: "own",
    values: { exitNode: "pixel-7" },
    updatedAt: new Date().toISOString(),
  },
};

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});

async function render(status: NetworkExitStatus, onClose = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <NetworkExitDialog provider={provider} status={status} onClose={onClose} />,
    );
  });
  return onClose;
}

function input(label: string) {
  const field = [...container.querySelectorAll("label")].find((item) => item.textContent === label);
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(field!.htmlFor)}`)!;
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("connects with the fields the server describes, keeping the key hidden", async () => {
  networkExit.connect.mockResolvedValue(connected);
  const onClose = await render(disconnected);
  expect(input("Auth key").type).toBe("password");
  await type(input("Auth key"), "secret-key");
  await type(input("Exit node"), "pixel-7");
  await act(async () => {
    container.querySelector("form")!.requestSubmit();
  });
  expect(networkExit.connect).toHaveBeenCalledWith({
    provider: "own",
    values: { authKey: "secret-key", exitNode: "pixel-7" },
  });
  expect(onClose).toHaveBeenCalled();
});

it("shows a saved connection without its key, and disconnects", async () => {
  networkExit.disconnect.mockResolvedValue(disconnected);
  await render(connected);
  expect(input("Exit node").value).toBe("pixel-7");
  expect(input("Auth key").value).toBe("");
  expect(input("Auth key").required).toBe(false);
  const disconnect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect",
  )!;
  await act(async () => disconnect.click());
  expect(networkExit.disconnect).toHaveBeenCalled();
});
