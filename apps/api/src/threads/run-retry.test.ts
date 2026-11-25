import { expect, it, vi } from "vitest";
import { retryFailedRun } from "./run-retry.js";

const actor = { spaceId: "space", userId: "user" };
const failedRun = {
  botId: "bot",
  trigger: "user",
  createdAt: new Date(1000),
  sourceMessageId: "asked",
  sourceMessage: { role: "user" },
  task: { prompt: "Summarize the report" },
};

function fixture(options: {
  failed?: Record<string, unknown> | null;
  prior?: boolean;
  later?: boolean;
}) {
  const runs: Array<Record<string, unknown>> = [];
  const tasks: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      // In order: the failed run, an earlier retry of it, anything that happened since.
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(options.failed === undefined ? failedRun : options.failed)
        .mockResolvedValueOnce(options.prior ? { id: "retry" } : null)
        .mockResolvedValueOnce(options.later ? { id: "newer" } : null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        runs.push(data);
        return { id: "retry" };
      }),
    },
    task: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        tasks.push(data);
        return { id: "task" };
      }),
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) },
    jobs: { enqueue },
  } as unknown as Parameters<typeof retryFailedRun>[0];
  return { deps, tx, runs, tasks, enqueue };
}

it("queues the same task again for the same message", async () => {
  const f = fixture({});
  await retryFailedRun(f.deps, actor, "thread", "failed");
  expect(f.tx.run.findFirst.mock.calls[0]?.[0].where).toMatchObject({
    id: "failed",
    spaceId: "space",
    threadId: "thread",
    userId: "user",
    status: "failed",
  });
  expect(f.tasks).toEqual([expect.objectContaining({ prompt: "Summarize the report" })]);
  expect(f.runs).toEqual([
    expect.objectContaining({
      botId: "bot",
      trigger: "follow_up",
      sourceMessageId: "asked",
      clientNonce: "retry:failed",
    }),
  ]);
  expect(f.enqueue).toHaveBeenCalledOnce();
});

it("queues nothing on a second tap", async () => {
  const f = fixture({ prior: true });
  await retryFailedRun(f.deps, actor, "thread", "failed");
  expect(f.runs).toEqual([]);
  expect(f.enqueue).not.toHaveBeenCalled();
});

it.each([
  ["a run that is not the caller's failed one", { failed: null }, "NOT_FOUND"],
  ["a routine's run", { failed: { ...failedRun, trigger: "routine" } }, "BAD_REQUEST"],
  [
    "a reply to another bot's message",
    { failed: { ...failedRun, trigger: "follow_up", sourceMessage: { role: "bot" } } },
    "BAD_REQUEST",
  ],
  ["a chat that has moved on", { later: true }, "CONFLICT"],
])("refuses %s", async (_case, options, code) => {
  const f = fixture(options);
  await expect(retryFailedRun(f.deps, actor, "thread", "failed")).rejects.toMatchObject({ code });
  expect(f.runs).toEqual([]);
  expect(f.enqueue).not.toHaveBeenCalled();
});
