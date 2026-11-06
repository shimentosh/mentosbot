// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorageSettingsPanel } from "./StorageSettings";

vi.mock("@lingui/react/macro", () => {
  // Stable like Lingui's own, since the form reloads when it changes.
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Label: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Switch: ({ checked, id }: { checked?: boolean; id?: string }) => (
    <input id={id} type="checkbox" checked={checked} readOnly />
  ),
}));
vi.mock("@rakazo/ui-web/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  CollapsibleContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ai/primitives", () => ({
  SuccessPop: () => null,
  Shimmer: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../lib/file-size", () => ({ formatSize: (bytes: number) => `${bytes} B` }));
const { storage } = vi.hoisted(() => ({
  storage: { get: vi.fn(), update: vi.fn(), usage: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    get objectStorage() {
      return { ...storage };
    },
  },
}));

const none = {
  source: "none" as const,
  active: true,
  endpoint: "",
  bucket: "",
  region: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  hasSecret: false,
};
const saved = {
  ...none,
  source: "settings" as const,
  endpoint: "https://storage.example.com",
  bucket: "rakazo-files",
  region: "us-east-1",
  accessKeyId: "key-id",
  hasSecret: true,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  storage.usage.mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
});

function field(label: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  const input = host.querySelector<HTMLInputElement>(`[id="${id}"]`);
  if (!input) throw new Error(`no ${label} field`);
  return input;
}

/** Types into the field labelled `label` the way a person pasting would. */
function paste(label: string, text: string) {
  const input = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("connects a bucket", async () => {
  storage.get.mockResolvedValue(none);
  storage.update.mockResolvedValue({ ...saved, active: true });
  await act(async () => root.render(<StorageSettingsPanel />));
  await act(async () => {
    paste("Endpoint", "https://storage.example.com");
    paste("Bucket", "rakazo-files");
    paste("Access key ID", "key-id");
    paste("Secret access key", "key-secret");
  });
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(storage.update).toHaveBeenCalledWith({
    endpoint: "https://storage.example.com",
    bucket: "rakazo-files",
    region: "",
    prefix: "",
    pathStyle: false,
    accessKeyId: "key-id",
    secretAccessKey: "key-secret",
  });
  // The secret is never shown back.
  expect(field("Secret access key").value).toBe("");
});

it("keeps the bucket that saved files are in and the saved secret", async () => {
  storage.get.mockResolvedValue(saved);
  await act(async () => root.render(<StorageSettingsPanel />));
  expect(field("Bucket").disabled).toBe(true);
  expect(field("Endpoint").disabled).toBe(true);
  expect(field("Access key ID").disabled).toBe(false);
  expect(field("Secret access key").required).toBe(false);
});

it("waits for the server to switch onto a new bucket", async () => {
  vi.useFakeTimers();
  storage.get.mockResolvedValueOnce({ ...saved, active: false });
  storage.get.mockRejectedValueOnce(new Error("restarting"));
  storage.get.mockResolvedValue(saved);
  await act(async () => root.render(<StorageSettingsPanel />));
  expect(host.textContent).toContain("Switching storage…");
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host.textContent).toContain("Switching storage…");
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host.textContent).not.toContain("Switching storage…");
});

it("shows a bucket from the server environment without letting it change", async () => {
  storage.get.mockResolvedValue({ ...saved, source: "environment" });
  await act(async () => root.render(<StorageSettingsPanel />));
  expect(host.textContent).toContain("Set by the server environment.");
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  expect(host.querySelector('button[type="submit"]')).toBeNull();
});

it("shows how much of a connected bucket is used", async () => {
  storage.get.mockResolvedValue(saved);
  storage.usage.mockResolvedValue({
    bytes: 1000,
    objects: 3,
    homes: 900,
    artifacts: 100,
    partial: false,
  });
  await act(async () => root.render(<StorageSettingsPanel />));
  expect(host.textContent).toContain("Connected");
  const usage = host.querySelector('[data-testid="storage-usage"]');
  expect(usage?.textContent).toContain("1000 B");
  expect(usage?.textContent).toContain("3 files");
  expect(usage?.textContent).toContain("Workspaces900 B");
  expect(usage?.textContent).toContain("Chat files100 B");
  expect(usage?.textContent).not.toContain("Other");
});

it("measures nothing until the server runs on the bucket", async () => {
  storage.get.mockResolvedValue({ ...saved, active: false });
  await act(async () => root.render(<StorageSettingsPanel />));
  expect(storage.usage).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Connected");
});
