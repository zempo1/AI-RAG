import { MindMapsService } from "../src/modules/mindmaps/mindmaps.service";
import { MINDMAP_PROMPT_VERSION } from "../src/modules/mindmaps/mindmap-planner";
import { pipeline } from "./helpers/pipeline";

const tree = '{"text":"主题","children":[{"text":"全篇要点"}]}';

it.each(["reported", "missing", "replaced"])(
  "settles cancellation usage safely: %s",
  async (mode) => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("正文"), "cancel.md", 1);
      await p.indexing.process(file.taskId);
      let id = 0;
      const service = new MindMapsService(
        p.documents,
        {
          complete: async (_p: string, _k: unknown, _i: unknown, _s: unknown, opts: any) => {
            await opts.onAttempt({ phase: "start" });
            await p.tasks.cancelMindMap(id, 1);
            if (mode === "replaced") {
              const current = await p.store.get("tasks", id);
              await p.store.save("tasks", {
                id,
                payload: { ...current!.payload, usageExecutionToken: "new-execution" },
              });
            }
            await opts.onAttempt({
              phase: "end",
              status: "cancelled",
              elapsedMs: 1,
              ...(mode === "missing"
                ? {}
                : { usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }),
            });
            return tree;
          },
        } as any,
        p.store,
        p.config,
        undefined,
        p.tasks,
      );
      id = (await service.generate(1, file.documentId)).taskId;
      await service.process(id);
      const result = await p.tasks.get(id, 1);
      expect(result.status).toBe("canceled");
      expect(result.mindmapProgress).toMatchObject({
        modelCalls: 1,
        inputTokens: mode === "reported" ? 20 : 0,
        outputTokens: mode === "reported" ? 5 : 0,
        totalTokens: mode === "reported" ? 25 : 0,
        usageReportedCalls: mode === "reported" ? 1 : 0,
        usageMissingCalls: mode === "missing" ? 1 : 0,
      });
      expect(await p.store.list("mindmaps")).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  },
);

it("persists usage from every actual attempt, including failed, truncated and compatibility attempts", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("短文知识"), "usage.md", 1);
    await p.indexing.process(file.taskId);
    const service = new MindMapsService(
      p.documents,
      {
        complete: async (
          _prompt: string,
          _key: unknown,
          _images: unknown,
          _signal: unknown,
          options: any,
        ) => {
          for (const event of [
            { status: "error" },
            { status: "success", usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } },
            { status: "success", usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
          ]) {
            await options.onAttempt({ phase: "start" });
            await options.onAttempt({ phase: "end", elapsedMs: 1, ...event });
          }
          return tree;
        },
      } as any,
      p.store,
      p.config,
      undefined,
      p.tasks,
    );
    const task = await service.generate(1, file.documentId);
    await service.process(task.taskId);
    const progress = (await p.tasks.get(task.taskId, 1)).mindmapProgress;
    expect(progress).toMatchObject({
      modelCalls: 3,
      inputTokens: 180,
      outputTokens: 50,
      totalTokens: 230,
      usageReportedCalls: 2,
      usageMissingCalls: 1,
      usageScope: "pipeline",
    });
    const map = (await p.store.list("mindmaps"))[0];
    expect(JSON.parse(map.data).meta.usage).toMatchObject({
      inputTokens: 180,
      outputTokens: 50,
      totalTokens: 230,
      usageReportedCalls: 2,
      usageMissingCalls: 1,
      usageScope: "pipeline",
    });
  } finally {
    await p.cleanup();
  }
});

it.each([
  {
    name: "same pipeline retry",
    version: MINDMAP_PROMPT_VERSION,
    previous: {
      modelCalls: 2,
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
      usageReportedCalls: 1,
      usageMissingCalls: 1,
    },
    expected: {
      modelCalls: 3,
      inputTokens: 40,
      outputTokens: 15,
      totalTokens: 55,
      usageReportedCalls: 2,
      usageMissingCalls: 1,
    },
  },
  {
    name: "legacy unrecorded attempts",
    version: MINDMAP_PROMPT_VERSION,
    previous: { modelCalls: 4 },
    expected: {
      modelCalls: 5,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageReportedCalls: 1,
      usageMissingCalls: 4,
    },
  },
  {
    name: "new pipeline scope",
    version: "older-pipeline",
    previous: {
      modelCalls: 4,
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      usageReportedCalls: 4,
      usageMissingCalls: 0,
    },
    expected: {
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageReportedCalls: 1,
      usageMissingCalls: 0,
    },
  },
])("accounts correctly for $name", async ({ version, previous, expected }) => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("短文知识"), "retry.md", 1);
    await p.indexing.process(file.taskId);
    const service = new MindMapsService(
      p.documents,
      {
        complete: async (
          _prompt: string,
          _key: unknown,
          _images: unknown,
          _signal: unknown,
          options: any,
        ) => {
          await options.onAttempt({ phase: "start" });
          await options.onAttempt({
            phase: "end",
            status: "success",
            elapsedMs: 1,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          });
          return tree;
        },
      } as any,
      p.store,
      p.config,
      undefined,
      p.tasks,
    );
    const task = await service.generate(1, file.documentId);
    const row = await p.store.get("tasks", task.taskId);
    await p.store.save("tasks", {
      id: task.taskId,
      payload: { ...row!.payload, pipelineVersion: version, mindmapProgress: previous },
    });
    await service.process(task.taskId, 2);
    expect((await p.tasks.get(task.taskId, 1)).mindmapProgress).toMatchObject({
      ...expected,
      usageScope: "pipeline",
    });
  } finally {
    await p.cleanup();
  }
});
