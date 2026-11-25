/** A full replacement diff keeps every removed constraint visible during approval. */
export function instructionUpdateDiff(before: string, after: string): string {
  if (!before.trim()) return after;
  const lines = (text: string, sign: string) =>
    text
      .split("\n")
      .map((line) => `${sign} ${line}`)
      .join("\n");
  return `${lines(before, "-")}\n${lines(after, "+")}`;
}

/** The lines that differ between two texts, without the lines they share at either end. */
export function changedLinesDiff(before: string, after: string): string {
  const removed = before.split("\n");
  const added = after.split("\n");
  let start = 0;
  while (start < removed.length && start < added.length && removed[start] === added[start])
    start += 1;
  let end = 0;
  while (
    end < removed.length - start &&
    end < added.length - start &&
    removed[removed.length - 1 - end] === added[added.length - 1 - end]
  )
    end += 1;
  return [
    ...removed.slice(start, removed.length - end).map((line) => `- ${line}`),
    ...added.slice(start, added.length - end).map((line) => `+ ${line}`),
  ].join("\n");
}
