import { ConfigService } from "@nestjs/config";
import { MemoryStore } from "../src/persistence/memory.store";
import { QuizRunner } from "../src/modules/quizzes/quiz-runner";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { ModelOutputError } from "../src/modules/llm/llm.types";
it("模型输出截断与结构无效分别展示可操作原因", async () => {
  const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "test-secret" });
  const store = new MemoryStore();
  await store.save("knowledgeBases", { id: 1, userId: 1 });
  await store.save("documents", {
    id: 1,
    userId: 1,
    knowledgeBaseId: 1,
    activeVersionId: 1,
    activeIndexRevisionId: 1,
  });
  await store.save("indexRevisions", { id: 1, documentId: 1, versionId: 1 });
  await store.save("chunks", {
    id: 1,
    documentId: 1,
    versionId: 1,
    indexRevisionId: 1,
    chunkIndex: 0,
    text: "原文证据",
  });
  await store.save("tasks", {
    id: 1,
    kind: "quiz",
    userId: 1,
    knowledgeBaseId: 1,
    documentId: 1,
    indexRevisionId: 1,
    status: "queued",
    payload: { versionId: 1, singleCount: 1, multipleCount: 0 },
    executionToken: null,
  });
  await new QuizRunner(
    store,
    {
      complete: async () => {
        throw new ModelOutputError("private-provider-response", "length");
      },
    } as any,
    config,
    new TokenizerService(config),
  ).process(1);
  expect((await store.get("tasks", 1))?.error).toContain("长度上限");
  expect((await store.get("tasks", 1))?.error).not.toContain("private-provider");
});
