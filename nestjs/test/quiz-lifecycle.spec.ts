import { ConfigService } from "@nestjs/config";
import { QuizzesService } from "../src/modules/quizzes/quizzes.service";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { pipeline } from "./helpers/pipeline";
const result = (id: number) =>
  JSON.stringify({
    questions: [
      {
        type: "SINGLE",
        stem: "测试知识点",
        options: ["A", "B", "C", "D"].map((id) => ({ id, text: `选项${id}` })),
        correctOptionIds: ["A"],
        explanation: "解释",
        optionExplanations: { A: "原因", B: "原因", C: "原因", D: "原因" },
        evidence: [{ chunkId: id, quote: "原文知识点" }],
      },
    ],
  });
describe("测验与已有任务、文档生命周期集成", () => {
  it.each(["delete", "replace"])("来源%s后失效的失败任务应销毁凭据并禁止重试", async (action) => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("原文知识点"), "quiz.md", 1);
      await p.indexing.process(file.taskId);
      const failed = await p.tasks.create(p.store, {
        userId: 1,
        knowledgeBaseId: file.knowledgeBaseId,
        documentId: file.documentId,
        indexRevisionId: (await p.store.get("documents", file.documentId))?.activeIndexRevisionId,
        kind: "quiz",
        status: "failed",
        stage: "failed",
        retryable: 1,
        payload: { credential: "private-cipher", modelSnapshot: "private-snapshot" },
      });
      if (action === "delete") await p.documents.delete(file.documentId, 1);
      else
        await p.documents.ingest(Buffer.from("新的原文知识点"), "quiz.md", 1, {
          documentId: file.documentId,
        });
      const task = await p.store.get("tasks", failed.id);
      expect(task?.retryable).toBe(0);
      expect(task?.payload.credential).toBeNull();
      expect(task?.payload.modelSnapshot).toBeNull();
    } finally {
      await p.cleanup();
    }
  });
  it("任务详情与工作台只能返回展示字段", async () => {
    const p = await pipeline();
    try {
      const kb = await p.libraries.resolve(1);
      const task = await p.tasks.create(p.store, {
        userId: 1,
        knowledgeBaseId: kb.id,
        kind: "quiz",
        payload: {
          credential: "private-key",
          modelSnapshot: "sealed",
          quizResult: { quizId: 9 },
          quizProgress: {
            modelCalls: 2,
            startedAt: "2026-11-17",
            rawResponse: "secret-answer",
            prompt: "private-source",
          },
        },
      });
      const row = await p.tasks.get(task.id, 1);
      expect(row.quizResult).toEqual({ quizId: 9 });
      expect(JSON.stringify(row)).not.toMatch(/private-|secret-answer|sealed|rawResponse/);
    } finally {
      await p.cleanup();
    }
  });
  it.each(["delete", "library", "replace", "cancel"])(
    "%s期间不得发布或保留失效题集",
    async (action) => {
      const p = await pipeline();
      let release!: () => void, enter!: () => void;
      const entered = new Promise<void>((r) => (enter = r));
      const pending = new Promise<void>((r) => (release = r));
      try {
        const file = await p.documents.ingest(Buffer.from("# 章节\n\n原文知识点"), "quiz.md", 1);
        await p.indexing.process(file.taskId);
        const chunk = (await p.store.list("chunks", { documentId: file.documentId }))[0];
        const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
        const service = new QuizzesService(
          p.documents,
          {
            complete: async () => {
              enter();
              await pending;
              return result(chunk.id);
            },
          } as any,
          p.store,
          config,
          new TokenizerService(config),
          p.tasks,
        );
        const accepted = await service.generate(1, file.documentId, 1, 0, undefined, "one");
        const run = service.process(accepted.taskId);
        await entered;
        if (action === "delete") await p.documents.delete(file.documentId, 1);
        if (action === "library") await p.documents.deleteLibrary(file.knowledgeBaseId, 1);
        if (action === "replace")
          await p.documents.ingest(Buffer.from("更新原文知识点"), "quiz.md", 1, {
            documentId: file.documentId,
          });
        if (action === "cancel") await p.tasks.cancelMindMap(accepted.taskId, 1);
        release();
        await run;
        expect(await p.store.list("quizzes")).toHaveLength(0);
        expect((await p.store.get("tasks", accepted.taskId))?.status).toBe("canceled");
      } finally {
        release?.();
        await p.cleanup();
      }
    },
  );
  it("生成请求去重、取消后不重试、失败可重试并递增投递代数", async () => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("原文知识点"), "quiz.md", 1);
      await p.indexing.process(file.taskId);
      const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
      const service = new QuizzesService(
        p.documents,
        {
          complete: async () => {
            throw new Error("provider unavailable");
          },
        } as any,
        p.store,
        config,
        new TokenizerService(config),
        p.tasks,
      );
      const first = await service.generate(1, file.documentId, 1, 0, undefined, "one");
      expect((await service.generate(1, file.documentId, 1, 0, undefined, "two")).taskId).toBe(
        first.taskId,
      );
      await expect(service.generate(1, file.documentId, 0, 1, undefined, "one")).rejects.toThrow();
      await service.process(first.taskId);
      expect((await p.tasks.get(first.taskId, 1)).status).toBe("failed");
      expect((await p.tasks.retry(first.taskId, 1)).dispatchGeneration).toBe(1);
      await p.tasks.cancelMindMap(first.taskId, 1);
      await expect(p.tasks.retry(first.taskId, 1)).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });
  it("已保存题集和练习在删除来源时级联，来源更新后允许练习并禁解释", async () => {
    const p = await pipeline();
    try {
      const file = await p.documents.ingest(Buffer.from("原文知识点"), "quiz.md", 1);
      await p.indexing.process(file.taskId);
      const chunk = (await p.store.list("chunks", { documentId: file.documentId }))[0];
      const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
      const service = new QuizzesService(
        p.documents,
        { complete: async () => result(chunk.id) } as any,
        p.store,
        config,
        new TokenizerService(config),
        p.tasks,
      );
      const accepted = await service.generate(1, file.documentId, 1, 0, undefined, "x");
      await service.process(accepted.taskId);
      const quiz = (await p.store.list("quizzes"))[0];
      const a = await service.startAttempt(quiz.id, 1, "a");
      const updated = await p.documents.ingest(Buffer.from("更新原文知识点"), "quiz.md", 1, {
        documentId: file.documentId,
      });
      await p.indexing.process(updated.taskId);
      const response = await service.progress(a.id, 1, {
        questionId: "q1",
        selectedOptionIds: ["A"],
        submit: true,
      });
      expect(response.score).toBe(100);
      expect(response.quiz.sourceOutdated).toBe(true);
      await expect(
        service.resolveChatContext(1, { attemptId: a.id, questionId: "q1" }, file.knowledgeBaseId),
      ).rejects.toThrow();
      await p.documents.delete(file.documentId, 1);
      expect(await p.store.list("quizzes")).toHaveLength(0);
      expect(await p.store.list("quizAttempts")).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  });
});
