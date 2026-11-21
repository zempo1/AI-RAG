import { jest } from "@jest/globals";
import { ConfigService } from "@nestjs/config";
import { AgentService } from "../src/modules/agent/agent.service";
import { RetrievalService } from "../src/modules/rag/retrieval.service";
import { MemoryStore } from "../src/persistence/memory.store";
import { AgentQaTasksService } from "../src/modules/tasks/agent-qa.service";
import { HistoryService } from "../src/modules/history/history.service";

const question = "请解释冬小麦的春化条件。";
const options = {
  mode: "search" as const,
  documentIds: [3],
  quizContext: { attemptId: 8, questionId: "q1" },
};

async function fixture() {
  const store = new MemoryStore();
  const kb = await store.save("knowledgeBases", { id: 2, userId: 1 });
  await store.save("documents", {
    id: 3,
    userId: 1,
    knowledgeBaseId: 2,
    filename: "植物.md",
    activeVersionId: 5,
    activeIndexRevisionId: 4,
  });
  await store.save("indexRevisions", { id: 4, documentId: 3 });
  await store.save("chunks", {
    id: 6,
    documentId: 3,
    versionId: 5,
    indexRevisionId: 4,
    chunkIndex: 0,
    text: "冬小麦需要低温处理。",
  });
  await store.save("chunks", {
    id: 9,
    documentId: 3,
    versionId: 5,
    indexRevisionId: 4,
    chunkIndex: 1,
    text: "冬小麦春化温度为 0～5°C，持续 40～50 天。",
  });
  await store.save("quizzes", {
    id: 7,
    userId: 1,
    knowledgeBaseId: 2,
    documentId: 3,
    versionId: 5,
    indexRevisionId: 4,
    questions: [{ id: "q1", evidence: [{ chunkId: 6, quote: "冬小麦需要低温处理。" }] }],
  });
  await store.save("quizAttempts", {
    id: 8,
    userId: 1,
    quizId: 7,
    answers: { q1: { submitted: true } },
  });
  const lib = { resolve: async () => kb, owned: async () => kb };
  const retrieval = new RetrievalService({} as any, {} as any, store, lib as any);
  const search = jest.spyOn(retrieval, "search");
  const complete = jest.fn<(prompt: string) => Promise<string>>();
  const config = new ConfigService({ JWT_SECRET: "test-secret" });
  const service = new AgentService(retrieval, { complete } as any, {} as any, config, store);
  const tasks = new AgentQaTasksService(
    store,
    new HistoryService(store, lib as any),
    lib as any,
    service,
    config,
  );
  return { store, search, complete, service, tasks };
}

it("uses validated quiz evidence directly when the assessment finds enough support", async () => {
  const f = await fixture();
  f.complete.mockImplementation(async (prompt) => {
    expect(prompt).toContain("冬小麦需要低温处理");
    const [source] = JSON.parse(prompt.split("\n原文：").at(-1)!);
    return JSON.stringify({
      supported: true,
      subQuestions: [{ question, status: "supported", evidenceIds: [source.id] }],
    });
  });
  const context = await f.service.prepare(question, 1, 2, options);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.search).not.toHaveBeenCalled();
  expect(context.sources.map((source) => source.chunkId)).toEqual([6]);
});

it("checks the same document for missing facts, then answers using the additional original text", async () => {
  const f = await fixture();
  f.complete.mockResolvedValueOnce(
    JSON.stringify({ supported: false, missing: ["冬小麦春化温度"], subQuestions: [] }),
  );
  f.complete.mockImplementationOnce(async (prompt) => {
    const sources = JSON.parse(prompt.split("\n原文：").at(-1)!);
    const source = sources.find((item: { text: string }) => item.text.includes("40～50"));
    expect(source).toBeDefined();
    return JSON.stringify({
      supported: true,
      subQuestions: [{ question, status: "supported", evidenceIds: [source.id] }],
    });
  });
  const context = await f.service.prepare(question, 1, 2, options);
  expect(f.search).toHaveBeenCalledTimes(1);
  expect(f.search.mock.calls[0][0].scope.documents.map((doc) => doc.documentId)).toEqual([3]);
  expect(context.sources.some((source) => source.text.includes("40～50"))).toBe(true);
});

it("keeps quiz context for background recovery and saves citations without appending evidence to the user message", async () => {
  const f = await fixture();
  const started = await f.tasks.begin(1, {
    ...options,
    question,
    knowledgeBaseId: 2,
    requestId: "quiz-explanation",
    fingerprint: "test",
  });
  await f.store.save("tasks", {
    id: started.task.id,
    payload: { ...started.task.payload, leaseUntil: 0 },
  });
  f.complete.mockImplementationOnce(async (prompt) => {
    const [source] = JSON.parse(prompt.split("\n原文：").at(-1)!);
    return JSON.stringify({
      supported: true,
      subQuestions: [{ question, status: "supported", evidenceIds: [source.id] }],
    });
  });
  f.complete.mockResolvedValueOnce("冬小麦需要低温处理。[1]");
  expect(await f.tasks.process(started.task.id)).toBe("done");
  expect(f.search).not.toHaveBeenCalled();
  const messages = await f.store.list("messages", { chatId: started.chat.id });
  expect(messages.find((message) => message.role === "user")?.content).toBe(question);
  expect(messages.find((message) => message.role === "assistant")?.citations).toMatchObject([
    { documentId: 3, chunkId: 6 },
  ]);
});

it("rejects historical quiz evidence when the current source version has changed", async () => {
  const f = await fixture();
  await f.store.save("documents", { id: 3, activeVersionId: 99 });
  await expect(f.service.prepare(question, 1, 2, options)).rejects.toThrow("来源已更新");
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.search).not.toHaveBeenCalled();
});
