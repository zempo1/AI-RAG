import { ConfigService } from "@nestjs/config";
import { MemoryStore } from "../src/persistence/memory.store";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { QuizRunner, selectQuizSources } from "../src/modules/quizzes/quiz-runner";
import {
  sealRuntimeModels,
  runWithModels,
  environmentBindings,
  modelBinding,
} from "../src/modules/model-settings/model-runtime";
import { sealQaCredential } from "../src/modules/tasks/qa-credentials";
import { ModelOutputError } from "../src/modules/llm/llm.types";
const q = (type: string, stem: string) => ({
  type,
  stem,
  options: ["A", "B", "C", "D"].map((id) => ({ id, text: `选项${id}` })),
  correctOptionIds: type === "SINGLE" ? ["A"] : ["A", "B"],
  explanation: "解释",
  optionExplanations: { A: "原因", B: "原因", C: "原因", D: "原因" },
  evidence: [{ chunkId: 1, quote: "原文证据" }],
});
describe("测验原文生成与发布竞态", () => {
  const config = new ConfigService({
    JWT_SECRET: "test-secret",
    STORAGE_DRIVER: "memory",
    CHAT_CONTEXT_TOKENS: 16000,
    CHAT_OUTPUT_TOKENS: 4096,
  });
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore();
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
      text: "这是原文证据，介绍知识点。",
    });
    await store.save("tasks", {
      id: 1,
      kind: "quiz",
      userId: 1,
      knowledgeBaseId: 1,
      documentId: 1,
      indexRevisionId: 1,
      status: "queued",
      payload: { versionId: 1, filename: "test.md", singleCount: 2, multipleCount: 1 },
      executionToken: null,
    });
  });
  it("选材去重且覆盖各章节及前后位置", () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      chunkIndex: i,
      text: `原文${i}`,
      location: { sectionTitle: `章节${Math.floor(i / 5)}` },
    }));
    const selected = selectQuizSources([...chunks, { ...chunks[0], id: 99 }], 4);
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((c) => c.location.sectionTitle)).size).toBe(4);
  });
  it("每批最多两题，一次修复后原子发布整套", async () => {
    let calls = 0;
    const llm = {
      complete: async () => {
        calls++;
        if (calls === 1) return "{}";
        return JSON.stringify({
          questions:
            calls === 2 ? [q("SINGLE", "题一"), q("SINGLE", "题二")] : [q("MULTIPLE", "题三")],
        });
      },
    };
    await new QuizRunner(store, llm as any, config, new TokenizerService(config)).process(1);
    const task = await store.get("tasks", 1);
    expect(task?.status).toBe("completed");
    expect(calls).toBe(3);
    const rows = await store.list("quizzes");
    expect(rows[0].questions).toHaveLength(3);
    expect(task?.payload.quizResult.quizId).toBe(rows[0].id);
  });
  it("连续无效最多一次修复，不留下半套测验", async () => {
    let calls = 0;
    await new QuizRunner(
      store,
      {
        complete: async () => {
          calls++;
          return "{}";
        },
      } as any,
      config,
      new TokenizerService(config),
    ).process(1);
    expect(calls).toBe(2);
    expect((await store.get("tasks", 1))?.status).toBe("failed");
    expect(await store.list("quizzes")).toHaveLength(0);
  });
  it("两题输出截断后改为每批一题，不发布半套且不改变配比", async () => {
    let calls = 0;
    await new QuizRunner(
      store,
      {
        complete: async () => {
          calls++;
          if (calls === 1) throw new ModelOutputError("length", "length");
          return JSON.stringify({
            questions: [q(calls < 4 ? "SINGLE" : "MULTIPLE", `恢复题${calls}`)],
          });
        },
      } as any,
      config,
      new TokenizerService(config),
    ).process(1);
    expect((await store.get("tasks", 1))?.status).toBe("completed");
    const quiz = (await store.list("quizzes"))[0];
    expect(quiz.questions.map((q: any) => q.type)).toEqual(["SINGLE", "SINGLE", "MULTIPLE"]);
    expect(calls).toBe(4);
  });
  it("模型期间来源更新或任务取消不可发布，后续可重新获取执行权", async () => {
    let calls = 0;
    const llm = {
      complete: async () => {
        calls++;
        await store.save("documents", { id: 1, activeVersionId: 2 });
        return JSON.stringify({ questions: [q("SINGLE", "题一"), q("SINGLE", "题二")] });
      },
    };
    await new QuizRunner(store, llm as any, config, new TokenizerService(config)).process(1);
    expect(calls).toBe(1);
    expect((await store.get("tasks", 1))?.status).toBe("canceled");
    expect(await store.list("quizzes")).toHaveLength(0);
  });
  it("模型错误和损坏凭据不泄露原始题目答案，不遗留运行中任务", async () => {
    await new QuizRunner(
      store,
      {
        complete: async () => {
          throw new Error("raw-answer-secret");
        },
      } as any,
      config,
      new TokenizerService(config),
    ).process(1);
    expect((await store.get("tasks", 1))?.error).not.toContain("raw-answer-secret");
    await store.save("tasks", {
      id: 1,
      status: "queued",
      executionToken: null,
      payload: { versionId: 1, singleCount: 1, multipleCount: 0, credential: "corrupted" },
    });
    await new QuizRunner(
      store,
      { complete: async () => "" } as any,
      config,
      new TokenizerService(config),
    ).process(1);
    expect((await store.get("tasks", 1))?.status).toBe("failed");
  });
  it("当前租约阻止重复执行，过期租约可以恢复且旧执行不能重复发布", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      blocked = new Promise<void>((r) => (release = r));
    let calls = 0;
    const llm = {
      complete: async () => {
        calls++;
        if (calls === 1) {
          enter();
          await blocked;
        }
        return JSON.stringify({
          questions: [q("SINGLE", `题${calls}a`), q("SINGLE", `题${calls}b`)],
        });
      },
    };
    await store.save("tasks", {
      id: 1,
      payload: { versionId: 1, singleCount: 2, multipleCount: 0 },
    });
    const runner = new QuizRunner(store, llm as any, config, new TokenizerService(config));
    const old = runner.process(1);
    await entered;
    expect(await runner.process(1)).toBe("waiting");
    const task = await store.get("tasks", 1);
    await store.save("tasks", { id: 1, payload: { ...task?.payload, leaseUntil: Date.now() - 1 } });
    await runner.process(1);
    release();
    await old;
    expect(await store.list("quizzes")).toHaveLength(1);
    expect(calls).toBe(2);
  });
  it("执行使用加密模型快照和凭据，成功后清理凭据", async () => {
    const snapshot = runWithModels(
      {
        userId: 1,
        bindings: {
          ...environmentBindings(config),
          chat: {
            provider: "openai-compatible",
            baseUrl: "http://fixture/v1",
            model: "snapshot-model",
            apiKey: "snapshot-secret",
            custom: true,
          },
        },
      },
      () => sealRuntimeModels(config),
    );
    await store.save("tasks", {
      id: 1,
      payload: {
        versionId: 1,
        singleCount: 1,
        multipleCount: 0,
        modelSnapshot: snapshot,
        credential: sealQaCredential("test-secret", "header-secret"),
      },
    });
    let model = "",
      key = "";
    const llm = {
      complete: async (_prompt: string, apiKey: string) => {
        model = modelBinding(config, "chat").model;
        key = apiKey;
        return JSON.stringify({ questions: [q("SINGLE", "快照题")] });
      },
    };
    await new QuizRunner(store, llm as any, config, new TokenizerService(config)).process(1);
    expect(model).toBe("snapshot-model");
    expect(key).toBe("header-secret");
    expect((await store.get("tasks", 1))?.payload.modelSnapshot).toBeNull();
    expect((await store.get("tasks", 1))?.payload.credential).toBeNull();
  });
  it("损坏的模型快照明确失败并可恢复，不会永远停在队列", async () => {
    await store.save("tasks", {
      id: 1,
      payload: { versionId: 1, singleCount: 1, multipleCount: 0, modelSnapshot: "invalid-sealed" },
    });
    await new QuizRunner(
      store,
      { complete: async () => "" } as any,
      config,
      new TokenizerService(config),
    ).process(1);
    expect((await store.get("tasks", 1))?.status).toBe("failed");
    expect((await store.get("tasks", 1))?.executionToken).toBeNull();
  });
});
