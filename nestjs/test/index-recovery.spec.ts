import { pipeline } from "./helpers/pipeline";
import { TaskQueueRuntime } from "../src/modules/tasks/task-queue.runtime";

it("does not steal a live index execution on duplicate delivery", async () => {
  const p = await pipeline();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const blocked = new Promise<void>((r) => (release = r));
  let calls = 0;
  p.beforeEmbedding(async () => {
    calls++;
    started();
    await blocked;
  });
  try {
    const upload = await p.documents.ingest(Buffer.from("租约隔离"), "lease.md", 1);
    const first = p.indexing.process(upload.taskId);
    await ready;
    const second = p.indexing.process(upload.taskId, 1);
    const result = await Promise.race([
      second,
      new Promise((r) => setTimeout(() => r("blocked"), 60)),
    ]);
    release();
    await Promise.all([first, second]);
    expect(result).toBe("waiting");
    expect(calls).toBe(1);
    expect((await p.store.get("tasks", upload.taskId))?.attempts).toBe(1);
  } finally {
    release?.();
    await p.cleanup();
  }
});

it("keeps attempts durable when a replacement Redis job starts at attempt one", async () => {
  const p = await pipeline();
  try {
    const upload = await p.documents.ingest(Buffer.from("持久重试次数"), "retry.md", 1);
    p.setFailure(true);
    for (let i = 0; i < 3; i++)
      await expect(p.indexing.process(upload.taskId, 1)).rejects.toThrow();
    const task = await p.store.get("tasks", upload.taskId);
    expect(task?.attempts).toBe(3);
    expect(task?.status).toBe("failed");
    expect(task?.payload?.indexAttempts).toHaveLength(3);
  } finally {
    await p.cleanup();
  }
});

it("caps orphan job recovery instead of resetting the budget indefinitely", async () => {
  const p = await pipeline();
  const runtime = new TaskQueueRuntime(p.config, p.store, p.indexing, p.tasks) as any;
  const jobs = {
    getJob: async () => ({ getState: async () => "failed", remove: async () => {} }),
    add: async () => {},
  };
  try {
    const upload = await p.documents.ingest(Buffer.from("恢复上限"), "orphan.md", 1);
    p.config.set("QUEUE_DRIVER", "bullmq");
    runtime.queues.set("documents", jobs);
    await p.store.save("tasks", {
      id: upload.taskId,
      status: "running",
      attempts: 3,
      payload: { indexLeaseUntil: 0 },
    });
    await runtime.dispatch();
    expect((await p.store.get("tasks", upload.taskId))?.status).toBe("failed");
  } finally {
    await p.cleanup();
  }
});

it("releases a canceled orphan's token so deletion cleanup can finish", async () => {
  const p = await pipeline();
  const runtime = new TaskQueueRuntime(p.config, p.store, p.indexing, p.tasks) as any;
  try {
    const upload = await p.documents.ingest(Buffer.from("删除后的孤儿执行"), "deleted.md", 1);
    await p.store.save("tasks", {
      id: upload.taskId,
      status: "canceled",
      executionToken: "dead-worker",
    });
    p.config.set("QUEUE_DRIVER", "bullmq");
    runtime.queues.set("documents", {
      getJob: async () => ({ getState: async () => "failed", remove: async () => {} }),
    });
    await runtime.dispatch();
    expect((await p.store.get("tasks", upload.taskId))?.executionToken).toBeNull();
  } finally {
    await p.cleanup();
  }
});
