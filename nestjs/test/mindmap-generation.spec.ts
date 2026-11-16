import { pipeline } from "./helpers/pipeline";
import { MindMapsService } from "../src/modules/mindmaps/mindmaps.service";
import { normalizeMindMap } from "../src/modules/mindmaps/mindmap-data";
import { ConfigService } from "@nestjs/config";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";

it("normalizes historical shapes and rejects invalid trees", () => {
  for (const value of [
    { root: { data: { text: "主题" } } },
    { data: { text: "主题" } },
    { nodeData: { topic: "主题" } },
  ]) {
    expect(normalizeMindMap(JSON.stringify(value)).root.data.text).toBe("主题");
  }
  expect(() => normalizeMindMap("{}")).toThrow();
});

it("accepts idempotently, reads beyond the old prefix and publishes once", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(
      Buffer.from("# 开篇\n\n" + "前文内容。".repeat(4500) + "\n\n# 末尾章节\n\n末尾独有知识点"),
      "长文.md",
      1,
    );
    await p.indexing.process(file.taskId);
    const prompts: string[] = [];
    const llm = {
      complete: async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes("提炼精简要点"))
          return '{"topics":[{"topic":"章节主题","points":["知识点与条件"]}]}';
        return JSON.stringify({
          root: { data: { text: "主题" }, children: [{ data: { text: "知识点" } }] },
        });
      },
    };
    const config = new ConfigService({
      STORAGE_DRIVER: "memory",
      CHAT_CONTEXT_TOKENS: 6000,
      CHAT_OUTPUT_TOKENS: 1000,
      JWT_SECRET: "x".repeat(32),
    });
    const maps = new MindMapsService(
      p.documents,
      llm as any,
      p.store,
      config,
      new TokenizerService(config),
      p.tasks,
    );
    const task = await maps.generate(1, file.documentId, undefined, "request-1");
    expect((await maps.generate(1, file.documentId, undefined, "request-1")).taskId).toBe(
      task.taskId,
    );
    expect(await p.store.list("mindmaps")).toHaveLength(0);
    await maps.process(task.taskId);
    await maps.process(task.taskId);
    expect(prompts.some((prompt) => prompt.includes("末尾独有知识点"))).toBe(true);
    expect(await p.store.list("mindmaps")).toHaveLength(1);
    expect((await p.tasks.get(task.taskId, 1)).mindmapResult.mindMapId).toBeDefined();
    const workspace = await maps.workspace(
      1,
      (await p.documents.owned(file.documentId, 1)).knowledgeBaseId,
    );
    expect(workspace.items[0].data).toBeUndefined();
    expect(workspace.generationTasks[0].payload?.credential).toBeUndefined();
  } finally {
    await p.cleanup();
  }
});

it("does not publish failed coverage and retries only uncached sections", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(
      Buffer.from(
        "# 第一节\n\nONE" +
          "甲".repeat(1500) +
          "\n\n# 第二节\n\nFAIL" +
          "乙".repeat(1500) +
          "\n\n# 第三节\n\nTHREE" +
          "丙".repeat(1500),
      ),
      "分节.md",
      1,
    );
    await p.indexing.process(file.taskId);
    let fail = true;
    const seen: string[] = [];
    const maps = new MindMapsService(
      p.documents,
      {
        complete: async (prompt: string) => {
          seen.push(prompt);
          if (fail && prompt.includes("FAIL")) throw new Error("provider unavailable");
          if (prompt.includes("提炼精简要点"))
            return '{"topics":[{"topic":"章节主题","points":["保留条件"]}]}';
          return '{"root":{"data":{"text":"主题"},"children":[]}}';
        },
      } as any,
      p.store,
      new ConfigService({
        STORAGE_DRIVER: "memory",
        JWT_SECRET: "x".repeat(32),
        CHAT_CONTEXT_TOKENS: 4096,
        CHAT_OUTPUT_TOKENS: 1024,
      }),
      undefined,
      p.tasks,
    );
    const accepted = await maps.generate(1, file.documentId, undefined, "retry-case");
    await maps.process(accepted.taskId);
    expect((await p.tasks.get(accepted.taskId, 1)).status).toBe("failed");
    expect(await p.store.list("mindmaps")).toHaveLength(0);
    expect(await p.store.list("summaryCaches")).toHaveLength(2);
    fail = false;
    await p.tasks.retry(accepted.taskId, 1);
    seen.length = 0;
    await maps.process(accepted.taskId);
    expect(seen.filter((prompt) => prompt.includes("提炼精简要点"))).toHaveLength(1);
    expect((await p.tasks.get(accepted.taskId, 1)).status).toBe("completed");
    const map = (await maps.list(1))[0] as any;
    await p.store.save("documents", { id: file.documentId, activeIndexRevisionId: 999 });
    expect((await maps.get(map.id, 1)).sourceOutdated).toBe(true);
  } finally {
    await p.cleanup();
  }
});

it("rejects retry when a replacement task is already active", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("正文"), "重试.md", 1);
    await p.indexing.process(file.taskId);
    const maps = new MindMapsService(p.documents, {} as any, p.store, p.config);
    const first = await maps.generate(1, file.documentId, undefined, "first");
    await p.store.save("tasks", { id: first.taskId, status: "failed" });
    await maps.generate(1, file.documentId, undefined, "replacement");
    await expect(p.tasks.retry(first.taskId, 1)).rejects.toThrow("已有生成中的思维导图任务");
  } finally {
    await p.cleanup();
  }
});

it("does not issue a JSON repair call after cancellation", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("正文"), "取消.md", 1);
    await p.indexing.process(file.taskId);
    let taskId = 0,
      calls = 0;
    const maps = new MindMapsService(
      p.documents,
      {
        complete: async () => {
          calls++;
          await p.tasks.cancelMindMap(taskId, 1);
          return "{}";
        },
      } as any,
      p.store,
      p.config,
    );
    taskId = (await maps.generate(1, file.documentId)).taskId;
    await maps.process(taskId);
    expect(calls).toBe(1);
    expect((await p.tasks.get(taskId, 1)).canDismiss).toBe(true);
    expect(await p.store.list("mindmaps")).toHaveLength(0);
  } finally {
    await p.cleanup();
  }
});

it("does not resurrect a map deleted with its source while a save is pending", async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from("正文"), "删除.md", 1);
    await p.indexing.process(file.taskId);
    const row = await p.store.save("mindmaps", {
      documentId: file.documentId,
      userId: 1,
      data: '{"data":{"text":"主题"}}',
    });
    const maps = new MindMapsService(p.documents, {} as any, p.store, p.config);
    const owned = maps.owned.bind(maps);
    maps.owned = async (id, userId) => {
      const result = await owned(id, userId);
      await p.documents.delete(file.documentId, 1);
      return result;
    };
    await expect(maps.update(row.id, 1, '{"data":{"text":"修改"}}')).rejects.toThrow();
    expect(await p.store.list("mindmaps")).toHaveLength(0);
  } finally {
    await p.cleanup();
  }
});
