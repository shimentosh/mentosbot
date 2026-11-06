// @vitest-environment jsdom
import type { FolderListing, ProjectFolderStatus } from "@rakazo/contracts";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: Pass,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
    Spinner: () => <span>loading</span>,
  };
});
const { projectFolder, client } = vi.hoisted(() => ({
  projectFolder: { get: vi.fn(), browse: vi.fn(), set: vi.fn(), stop: vi.fn() },
  client: { current: undefined as unknown },
}));
vi.mock("../lib/rpc", () => ({ rpc: { projectFolder }, selectedSpaceId: () => "space-1" }));
vi.mock("../lib/query", () => ({
  get queryClient() {
    return client.current;
  },
  spaceQueries: () => ({ key: () => ["space"] }),
  useQueryUserId: () => "user-1",
}));

import { ProjectFolderSection } from "./ProjectFolderSection";

const empty: ProjectFolderStatus = {
  available: true,
  connected: true,
  folder: null,
  processes: [],
};
const withFolder: ProjectFolderStatus = {
  available: true,
  connected: true,
  folder: { path: "/Users/ada/Code/contentos-ui", name: "contentos-ui" },
  processes: [
    {
      name: "dev-server",
      running: true,
      command: "pnpm dev",
      folder: "/Users/ada/Code/contentos-ui",
      ports: [3000],
    },
  ],
};
const home: FolderListing = {
  home: "/Users/ada",
  path: "/Users/ada",
  parent: null,
  folders: [
    { name: "Code", project: false },
    { name: "contentos-ui", project: true },
  ],
};

let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client.current = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<ProjectFolderSection botId="bot-1" />);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label));

it("stays hidden for a bot that cannot reach its owner's computer", async () => {
  projectFolder.get.mockResolvedValue({ ...empty, available: false });
  await render();
  expect(container.querySelector('[data-testid="project-folder"]')).toBeNull();
});

it("picks a project from the owner's computer with one press", async () => {
  projectFolder.get.mockResolvedValue(empty);
  projectFolder.browse.mockResolvedValue(home);
  projectFolder.set.mockResolvedValue(withFolder);
  await render();
  await act(async () => button("Choose folder")?.click());
  expect(projectFolder.browse).toHaveBeenCalledWith({ botId: "bot-1", path: undefined });
  expect(container.textContent).toContain("contentos-ui");
  await act(async () => button("Use")?.click());
  expect(projectFolder.set).toHaveBeenCalledWith({
    botId: "bot-1",
    path: "/Users/ada/contentos-ui",
  });
  expect(container.textContent).toContain("pnpm dev");
});

it("shows what the bot keeps running, opens its port and stops it", async () => {
  projectFolder.get.mockResolvedValue(withFolder);
  projectFolder.stop.mockResolvedValue({ ...withFolder, processes: [] });
  await render();
  const link = container.querySelector<HTMLAnchorElement>('a[href="http://localhost:3000"]');
  expect(link?.target).toBe("_blank");
  await act(async () => button("Stop")?.click());
  expect(projectFolder.stop).toHaveBeenCalledWith({ botId: "bot-1", name: "dev-server" });
  expect(container.querySelector('[data-testid="kept-command"]')).toBeNull();
});
