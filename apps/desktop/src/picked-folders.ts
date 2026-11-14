import path from "node:path";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const FILE = "picked-folders.json";
const MAX_FOLDERS = 50;
const MAX_BYTES = 256 * 1024;

/**
 * Folders outside the home the person picked with the system's folder picker. The server's bots
 * may work in them too, as in the home. Kept on this computer only, newest first.
 */
export async function loadPickedFolders(dir: string, home: string) {
  const file = path.join(dir, FILE);
  let folders: string[] = [];
  try {
    const parsed: unknown = JSON.parse((await readPrivateFile(file, MAX_BYTES)) ?? "[]");
    if (Array.isArray(parsed))
      folders = parsed
        .filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder))
        .slice(0, MAX_FOLDERS);
  } catch {
    // An unreadable list starts empty: the person picks the folder again.
  }
  const inside = (root: string, folder: string) => {
    const relative = path.relative(root, folder);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };
  return {
    list: (): readonly string[] => folders,
    /** Remembers a picked folder unless the home or a folder already picked holds it. */
    async add(picked: string) {
      const folder = path.resolve(picked);
      if (inside(home, folder) || folders.some((root) => inside(root, folder))) return;
      folders = [folder, ...folders.filter((root) => !inside(folder, root))].slice(0, MAX_FOLDERS);
      await writePrivateFile(file, JSON.stringify(folders));
    },
  };
}
