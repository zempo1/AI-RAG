import { ConfigService } from "@nestjs/config";
import { MemoryStore } from "../src/persistence/memory.store";
import { QuizzesService } from "../src/modules/quizzes/quizzes.service";
import {
  normalizeQuestions,
  scoreAnswers,
  presentQuestions,
} from "../src/modules/quizzes/quiz-data";

const question = (type = "SINGLE", id = "q1") => ({
  id,
  type,
  stem: "知识点" + id,
  options: ["A", "B", "C", "D"].map((id) => ({ id, text: "选项" + id })),
  correctOptionIds: type === "SINGLE" ? ["A"] : ["A", "C"],
  explanation: "根据原文分析",
  optionExplanations: { A: "正确原因", B: "错误原因", C: "解释原因", D: "错误原因" },
  evidence: [{ chunkId: 1, quote: "证据原文" }],
});

describe("测验权威校验与判分", () => {
  it("未提交不下发答案和任何解析，提交后只揭示对应题", () => {
    const questions = [question(), question("MULTIPLE", "q2")];
    const output = presentQuestions(questions, {
      q1: { selectedOptionIds: ["A"], submitted: true },
    });
    expect(output[0].correctOptionIds).toEqual(["A"]);
    expect(JSON.stringify(output[1])).not.toMatch(
      /correctOptionIds|explanation|optionExplanations/,
    );
  });
  it("多选完全匹配、每题等权、草稿不计分", () => {
    const questions = [question(), question("MULTIPLE", "q2")];
    expect(
      scoreAnswers(questions, {
        q1: { submitted: true, selectedOptionIds: ["A"] },
        q2: { submitted: true, selectedOptionIds: ["A"] },
      }),
    ).toMatchObject({ score: 50, correctCount: 1, answeredCount: 2 });
    expect(
      scoreAnswers(questions, { q1: { submitted: false, selectedOptionIds: ["A"] } }).score,
    ).toBe(0);
  });
  it("拒绝答案基数、跨来源证据、重复题干、缺失逐项解析", () => {
    const chunks = [{ id: 1, text: "这是证据原文" }];
    expect(() => normalizeQuestions([question()], 1, 0, chunks)).not.toThrow();
    for (const bad of [
      { ...question(), correctOptionIds: ["A", "B"] },
      { ...question(), evidence: [{ chunkId: 9, quote: "证据原文" }] },
      { ...question(), optionExplanations: { A: "x" } },
    ])
      expect(() => normalizeQuestions([bad], 1, 0, chunks)).toThrow();
    expect(() =>
      normalizeQuestions([question(), { ...question(), id: "q2" }], 2, 0, chunks),
    ).toThrow();
  });
});

describe("测验恢复、权限与原子提交", () => {
  let store: MemoryStore, service: QuizzesService, quizId: number;
  beforeEach(async () => {
    store = new MemoryStore();
    await store.save("knowledgeBases", { id: 1, userId: 1 });
    await store.save("documents", {
      id: 1,
      userId: 1,
      knowledgeBaseId: 1,
      activeVersionId: 1,
      activeIndexRevisionId: 1,
      status: "ready",
    });
    const quiz = await store.save("quizzes", {
      userId: 1,
      knowledgeBaseId: 1,
      documentId: 1,
      versionId: 1,
      indexRevisionId: 1,
      title: "测试",
      filename: "test.md",
      singleCount: 1,
      multipleCount: 1,
      questions: [question(), question("MULTIPLE", "q2")],
    });
    quizId = quiz.id;
    service = new QuizzesService(
      {} as any,
      {} as any,
      store,
      new ConfigService({ JWT_SECRET: "test-secret", STORAGE_DRIVER: "memory" }),
    );
  });
  it("重复创建幂等，刷新恢复草稿，重练保留旧成绩", async () => {
    const first = await service.startAttempt(quizId, 1, "request-one");
    expect((await service.startAttempt(quizId, 1, "request-one")).id).toBe(first.id);
    await service.progress(first.id, 1, {
      questionId: "q2",
      selectedOptionIds: ["C"],
      currentIndex: 1,
    });
    expect((await service.getAttempt(first.id, 1)).answers.q2.selectedOptionIds).toEqual(["C"]);
    expect((await service.startAttempt(quizId, 1, "request-two")).id).not.toBe(first.id);
    expect(await store.list("quizAttempts")).toHaveLength(2);
    const quiz: any = await service.get(quizId, 1);
    expect(quiz.attempts).toHaveLength(2);
    expect(quiz.attempts[1].id).toBe(first.id);
    expect((await service.getAttempt(quiz.attempts[1].id, 1)).answers.q2.selectedOptionIds).toEqual(
      ["C"],
    );
  });
  it("同requestId并发创建相同练习，事务必须先取库/文档/题集锁再建立普通读快照", async () => {
    const traces: string[][] = [];
    const observed = new Proxy(store, {
      get(target, key) {
        if (key === "transaction")
          return async (work: any) =>
            target.transaction(async (tx) => {
              const trace: string[] = [];
              traces.push(trace);
              const proxy = new Proxy(tx, {
                get(target, key) {
                  const value = (target as any)[key];
                  if (["get", "lock", "list"].includes(String(key)))
                    return (...args: any[]) => {
                      trace.push(`${String(key)}:${args[0]}`);
                      return value.apply(target, args);
                    };
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
              return work(proxy);
            });
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observedService = new QuizzesService(
      {} as any,
      {} as any,
      observed,
      new ConfigService({ JWT_SECRET: "test-secret", STORAGE_DRIVER: "memory" }),
    );
    const [first, second] = await Promise.all([
      observedService.startAttempt(quizId, 1, "concurrent-request"),
      observedService.startAttempt(quizId, 1, "concurrent-request"),
    ]);
    expect(first.id).toBe(second.id);
    expect(await store.list("quizAttempts")).toHaveLength(1);
    for (const trace of traces)
      expect(trace.slice(0, 3)).toEqual(["lock:knowledgeBases", "lock:documents", "lock:quizzes"]);
  });
  it("并发重复提交只能判分一次，已提交答案不可覆盖", async () => {
    const a = await service.startAttempt(quizId, 1, "x");
    const submissions = await Promise.allSettled([
      service.progress(a.id, 1, { questionId: "q1", selectedOptionIds: ["A"], submit: true }),
      service.progress(a.id, 1, { questionId: "q1", selectedOptionIds: ["B"], submit: true }),
    ]);
    expect(submissions[1].status).toBe("rejected");
    const result = await service.getAttempt(a.id, 1);
    expect(result.answers.q1.selectedOptionIds).toEqual(["A"]);
    expect(result.score).toBe(50);
    expect(result.questions[1].correctOptionIds).toBeUndefined();
    await expect(service.getAttempt(a.id, 2)).rejects.toThrow();
  });
  it("解释拒绝未交题及过期来源，限制单来源和库", async () => {
    const a = await service.startAttempt(quizId, 1, "x");
    await expect(
      service.resolveChatContext(1, { attemptId: a.id, questionId: "q1" }, 1),
    ).rejects.toThrow();
    await service.progress(a.id, 1, { questionId: "q1", selectedOptionIds: ["A"], submit: true });
    const context = await service.resolveChatContext(1, { attemptId: a.id, questionId: "q1" }, 1);
    expect(context.documentIds).toEqual([1]);
    expect(context.question).toContain("测验参考答案");
    expect(context.question).not.toContain("原文证据");
    expect(context.question).not.toContain("逐项解析：");
    expect(context.question).not.toContain("chunkId");
    await expect(
      service.resolveChatContext(1, { attemptId: a.id, questionId: "q1" }, 2),
    ).rejects.toThrow();
    await store.save("documents", { id: 1, activeVersionId: 2 });
    expect((await service.getAttempt(a.id, 1)).quiz.sourceOutdated).toBe(true);
    await expect(
      service.resolveChatContext(1, { attemptId: a.id, questionId: "q1" }, 1),
    ).rejects.toThrow();
  });
  it("删除题集级联练习，非法选项与空提交拒绝", async () => {
    const a = await service.startAttempt(quizId, 1, "x");
    await expect(
      service.progress(a.id, 1, { questionId: "q1", selectedOptionIds: ["X"], submit: true }),
    ).rejects.toThrow();
    await expect(
      service.progress(a.id, 1, { questionId: "q1", selectedOptionIds: [], submit: true }),
    ).rejects.toThrow();
    await service.delete(quizId, 1);
    expect(await store.list("quizAttempts")).toHaveLength(0);
  });
  it("多选漏选一项允许提交并计零分，已判题上下文要求核对参考答案", async () => {
    const a = await service.startAttempt(quizId, 1, "one-option");
    const marked = await service.progress(a.id, 1, {
      questionId: "q2",
      selectedOptionIds: ["A"],
      submit: true,
    });
    expect(marked.answers.q2.submitted).toBe(true);
    expect(marked.answers.q2.isCorrect).toBe(false);
    expect(marked.score).toBe(0);
    const context = await service.resolveChatContext(1, { attemptId: a.id, questionId: "q2" }, 1);
    expect(context.question).toContain("测验参考答案");
    expect(context.question).toContain("若参考答案/解析有误请明确指出");
  });
});
