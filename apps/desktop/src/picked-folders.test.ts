import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadPickedFolders } from "./picked-folders.js";

let dir: string;
const home = path.resolve("/home/fake");
const projects = path.resolve("/data/projects");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-picked-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("remembers folders picked outside the home, newest first, across launches", async () => {
  const picked = await loadPickedFolders(dir, home);
  await picked.add(path.join(home, "code"));
  expect(picked.list()).toEqual([]);
  await picked.add(path.join(projects, "site"));
  await picked.add(path.resolve("/data/other"));
  expect(picked.list()).toEqual([path.resolve("/data/other"), path.join(projects, "site")]);
  expect((await loadPickedFolders(dir, home)).list()).toEqual(picked.list());
});

it("keeps one entry for nested picks, the outer folder", async () => {
  const picked = await loadPickedFolders(dir, home);
  await picked.add(path.join(projects, "site"));
  await picked.add(projects);
  await picked.add(path.join(projects, "site", "src"));
  expect(picked.list()).toEqual([projects]);
});

it("starts empty without a saved list", async () => {
  expect((await loadPickedFolders(path.join(dir, "missing"), home)).list()).toEqual([]);
});
