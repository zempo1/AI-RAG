import { ConfigService } from "@nestjs/config";
import { MindMapsService } from "../src/modules/mindmaps/mindmaps.service";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { MindMapPlanner } from "../src/modules/mindmaps/mindmap-planner";
import { pipeline } from "./helpers/pipeline";

const tree = '{"text":"主题","children":[{"text":"全篇要点"}]}';
const notes = '{"topics":[{"topic":"主题","points":["要点与条件"]}]}';

it("packs 42 pages / 154KB across page boundaries into at most 8 complete batches", async () => {
  const config = new ConfigService({
    STORAGE_DRIVER: "memory",
    CHAT_TOKENIZER: "estimate:utf8-v1",
  });
  const chunks = Array.from({ length: 42 }, (_, i) => ({
    id: i + 1,
    documentId: 1,
    versionId: 2,
    indexRevisionId: 3,
    chunkIndex: i,
    text: "unused child",
    location: { page: i + 1, contentType: i === 40 ? "table" : i === 41 ? "ocr" : "text" },
    retrievalMetadata: {
      parentId: `p${i}`,
      parentText: `${i === 41 ? "TAIL-OCR" : i === 40 ? "TABLE" : "PAGE"}${"文".repeat(1218)}`,
    },
  }));
  const planner = new MindMapPlanner(config, new TokenizerService(config));
  const { batches: groups, strategy } = await planner.plan([...chunks, chunks[0]]);
  expect(strategy).toBe("batched");
  expect(groups.length).toBeLessThanOrEqual(8);
  expect(groups.join("\n")).toContain("TAIL-OCR");
  expect(groups.join("\n")).toContain("TABLE");
  expect(groups.join("\n").match(/PAGE/g)).toHaveLength(40);
  expect(groups.join("\n")).toContain("ocr");
});

it("generates a short document in one full-tree call and clears mapping counters", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("短文完整知识"), "short.md", 1);
    await p.indexing.process(file.taskId);
    const calls: any[] = [];
    const stages: any[] = [];
    const service = new MindMapsService(
      p.documents,
      {
        complete: async (...args: any[]) => {
          calls.push(args);
          return tree;
        },
      } as any,
      p.store,
      p.config,
      undefined,
      p.tasks,
    );
    const task = await service.generate(1, file.documentId);
    await service.process(task.taskId, 1, async (value) => {
      stages.push(value);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][4].maxOutputTokens).toBe(4096);
    expect(stages.map((s) => s.stage)).toContain("generating");
    expect(stages.map((s) => s.stage)).not.toContain("mapping");
    expect((await p.store.get("tasks", task.taskId))?.payload.mindmapProgress.strategy).toBe(
      "direct",
    );
    expect((await p.store.get("tasks", task.taskId))?.total).toBeNull();
    expect((await p.store.list("summaryCaches"))[0].payload.promptVersion).toBe("mindmap-v4");
  } finally {
    await p.cleanup();
  }
});

it.each([3, 1])(
  "extracts with concurrency %s, stable source order, then generates one tree",
  async (concurrency) => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("正文"), "long.md", 1);
      await p.indexing.process(file.taskId);
      const doc = await p.documents.owned(file.documentId, 1);
      for (const chunk of await p.store.list("chunks")) await p.store.delete("chunks", chunk.id);
      for (let i = 0; i < 8; i++)
        await p.store.save("chunks", {
          documentId: doc.id,
          versionId: doc.activeVersionId,
          indexRevisionId: doc.activeIndexRevisionId,
          chunkIndex: i,
          text: `SOURCE-${i}-` + "长".repeat(1800),
          location: { page: i + 1 },
        });
      const config = new ConfigService({
        STORAGE_DRIVER: "memory",
        JWT_SECRET: "x".repeat(32),
        CHAT_CONTEXT_TOKENS: 4608,
        CHAT_OUTPUT_TOKENS: 1024,
        MINDMAP_CONCURRENCY: concurrency,
      });
      let active = 0,
        peak = 0,
        finals = 0;
      const completed: number[] = [];
      const service = new MindMapsService(
        p.documents,
        {
          complete: async (prompt: string, ...args: any[]) => {
            const options = args[3];
            await options.onAttempt?.({ phase: "start" });
            if (prompt.includes("提炼精简要点")) {
              const i = Number(/SOURCE-(\d+)/.exec(prompt)?.[1]);
              peak = Math.max(peak, ++active);
              await new Promise((resolve) => setTimeout(resolve, 10 + (8 - i) * 2));
              active--;
              completed.push(i);
              await options.onAttempt?.({ phase: "end", status: "success", elapsedMs: 10 });
              return JSON.stringify({ topics: [{ topic: `NOTE-${i}`, points: ["必要条件"] }] });
            }
            finals++;
            expect(active).toBe(0);
            expect(completed).toHaveLength(8);
            for (let i = 0; i < 7; i++)
              expect(prompt.indexOf(`NOTE-${i}`)).toBeLessThan(prompt.indexOf(`NOTE-${i + 1}`));
            await options.onAttempt?.({ phase: "end", status: "success", elapsedMs: 1 });
            return JSON.stringify({
              title: "主题",
              groups: [{ title: "章节", ids: Array.from({ length: 8 }, (_, i) => `t${i + 1}`) }],
            });
          },
        } as any,
        p.store,
        config,
        new TokenizerService(config),
        p.tasks,
      );
      const task = await service.generate(1, file.documentId);
      const progress: number[] = [];
      await service.process(task.taskId, 1, async (value: any) => {
        if (value.stage === "mapping") progress.push(value.completed);
      });
      expect(await p.store.get("tasks", task.taskId)).toMatchObject({
        status: "completed",
        error: null,
      });
      expect(peak).toBe(concurrency);
      expect(finals).toBe(1);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      expect((await p.store.get("tasks", task.taskId))?.payload.mindmapProgress.modelCalls).toBe(9);
    } finally {
      await p.cleanup();
    }
  },
);
