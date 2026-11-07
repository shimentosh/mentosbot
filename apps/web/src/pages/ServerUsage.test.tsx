// @vitest-environment jsdom

import type { ComputerServerUsage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const computerServers = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { computerServers } }));
vi.mock("../lib/query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    useQueryUserId: () => "user-1",
  };
});
vi.mock("../lib/file-size", () => ({ formatSize: (bytes: number) => `${bytes / 1e9} GB` }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import { ServerUsage } from "./ServerUsage";

const GB = 1e9;
const server = (usage: Partial<NonNullable<ComputerServerUsage["usage"]>> = {}) => ({
  id: null,
  name: "",
  usage: {
    cpus: 4,
    load: 1,
    memory: { total: 8 * GB, available: 6 * GB },
    disk: { total: 100 * GB, available: 80 * GB },
    computers: [
      { name: "Social", team: true, running: true, memory: 2 * GB },
      { name: "Writer", team: false, running: false, memory: null },
    ],
    ...usage,
  },
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

async function render(data: unknown) {
  computerServers.usage.mockResolvedValue(data);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ServerUsage />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

it("shows how busy this server is and which computers are running", async () => {
  const view = await render([server()]);
  const text = view.textContent ?? "";
  expect(text).toContain("This server");
  expect(text).toContain("25% of 4 cores");
  expect(text).toContain("2 GB of 8 GB");
  expect(text).toContain("20 GB of 100 GB");
  expect(text).toContain("1 computer running");
  expect(text).toContain("Team · Social");
  expect(text).not.toContain("Writer");
  expect(text).not.toContain("Almost full");
});

it("warns when a server is nearly full", async () => {
  const view = await render([server({ memory: { total: 8 * GB, available: 0.5 * GB } })]);
  expect(view.textContent).toContain("Almost full. Add a server before adding more bots.");
});

it("names an added server and says when it does not answer", async () => {
  const view = await render([server(), { id: "server-2", name: "Second VPS", usage: null }]);
  expect(view.textContent).toContain("Second VPS");
  expect(view.textContent).toContain("Not answering");
});
