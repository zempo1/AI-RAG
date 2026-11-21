import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { DocumentsService } from "../documents/documents.service";
import { LlmService } from "../llm/llm.service";
import { Store, Row, now, publicRow } from "../../persistence/store";
import { ApiError } from "../../common/api-error";
import { TokenizerService } from "../embeddings/tokenizer.service";
import { TasksService, terminalTask } from "../tasks/tasks.service";
import { sealRuntimeModels } from "../model-settings/model-runtime";
import { sealQaCredential } from "../tasks/qa-credentials";
import {
  presentQuestions,
  scoreAnswers,
  sameOptions,
  validateCounts,
  OPTION_IDS,
  QuizQuestion,
  Answers,
} from "./quiz-data";
import { QuizRunner } from "./quiz-runner";

export interface ProgressInput {
  currentIndex?: number;
  questionId?: string;
  selectedOptionIds?: string[];
  submit?: boolean;
}
@Injectable()
export class QuizzesService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
    private readonly store: Store,
    @Optional() private readonly config: ConfigService = new ConfigService(),
    @Optional() private readonly tokenizer: TokenizerService = new TokenizerService(config),
    @Optional() private readonly tasks?: TasksService,
  ) {}
  async generate(
    userId: number,
    documentId: number,
    singleCount: number,
    multipleCount: number,
    apiKey?: string,
    requestId: string = randomUUID(),
  ) {
    validateCounts(singleCount, multipleCount);
    const doc = await this.documents.ready(documentId, userId);
    if (
      !doc.activeIndexRevisionId ||
      doc.status !== "ready" ||
      (doc.desiredIndexRevisionId != null &&
        doc.desiredIndexRevisionId !== doc.activeIndexRevisionId)
    )
      throw new ApiError(409, "文档尚未就绪，请等待索引完成");
    const row = await this.store.transaction(async (tx) => {
      const kb = await tx.lock("knowledgeBases", doc.knowledgeBaseId);
      const source = await tx.lock("documents", doc.id);
      if (
        !kb ||
        kb.deletedAt ||
        kb.userId !== userId ||
        !source ||
        source.deletedAt ||
        source.userId !== userId
      )
        throw new ApiError(404, "来源已删除");
      if (
        source.status !== "ready" ||
        source.activeVersionId !== doc.activeVersionId ||
        source.activeIndexRevisionId !== doc.activeIndexRevisionId ||
        (source.desiredIndexRevisionId != null &&
          source.desiredIndexRevisionId !== source.activeIndexRevisionId)
      )
        throw new ApiError(409, "来源已更新，请重新生成");
      const key = `quiz/${userId}/${requestId}`;
      const tasks = await tx.list("tasks", { userId, kind: "quiz" });
      const previous = tasks.find(
        (t) => t.idempotencyKey === key || t.payload?.requestIds?.includes(requestId),
      );
      if (previous) {
        if (
          previous.documentId !== doc.id ||
          previous.indexRevisionId !== doc.activeIndexRevisionId ||
          previous.payload?.singleCount !== singleCount ||
          previous.payload?.multipleCount !== multipleCount
        )
          throw new ApiError(409, "requestId 已用于不同测验配置");
        return previous;
      }
      const active = tasks.find(
        (t) =>
          t.documentId === doc.id &&
          t.indexRevisionId === doc.activeIndexRevisionId &&
          t.payload?.singleCount === singleCount &&
          t.payload?.multipleCount === multipleCount &&
          !terminalTask(t.status),
      );
      if (active)
        return tx.save("tasks", {
          id: active.id,
          payload: {
            ...active.payload,
            requestIds: [...new Set([...(active.payload?.requestIds || []), requestId])],
          },
        });
      return tx.save("tasks", {
        userId,
        knowledgeBaseId: doc.knowledgeBaseId,
        documentId: doc.id,
        indexRevisionId: doc.activeIndexRevisionId,
        parentTaskId: null,
        idempotencyKey: key,
        kind: "quiz",
        status: "queued",
        stage: "queued",
        completed: 0,
        total: singleCount + multipleCount,
        attempts: 0,
        dispatchGeneration: 0,
        retryable: 1,
        error: null,
        executionToken: null,
        updatedAt: now(),
        payload: {
          versionId: doc.activeVersionId,
          filename: doc.filename,
          singleCount,
          multipleCount,
          requestId,
          modelSnapshot: sealRuntimeModels(this.config),
          credential: sealQaCredential(this.config.getOrThrow("JWT_SECRET"), apiKey),
        },
      });
    });
    return { taskId: row.id, status: row.status };
  }
  process(id: number, attempt = 1, report?: (value: object) => Promise<void>) {
    return new QuizRunner(this.store, this.llm, this.config, this.tokenizer).process(
      id,
      attempt,
      report,
    );
  }
  private async source(quiz: Row, userId: number, tx = this.store, lock = false) {
    const kb = lock
      ? await tx.lock("knowledgeBases", quiz.knowledgeBaseId)
      : await tx.get("knowledgeBases", quiz.knowledgeBaseId);
    const doc = lock
      ? await tx.lock("documents", quiz.documentId)
      : await tx.get("documents", quiz.documentId);
    if (
      !kb ||
      kb.deletedAt ||
      kb.userId !== userId ||
      !doc ||
      doc.deletedAt ||
      doc.userId !== userId ||
      doc.knowledgeBaseId !== quiz.knowledgeBaseId
    )
      throw new ApiError(404, "测验来源不存在");
    return doc;
  }
  private async owned(id: number, userId: number, tx = this.store) {
    const q = await tx.get("quizzes", id);
    if (!q || q.userId !== userId) throw new ApiError(404, "测验不存在");
    await this.source(q, userId, tx);
    return q;
  }
  private stats(row: Row) {
    return {
      id: row.id,
      status: row.status,
      score: row.score,
      correctCount: row.correctCount,
      answeredCount: row.answeredCount,
      totalCount: row.totalCount,
      currentIndex: row.currentIndex,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }
  private async present(quiz: Row, userId: number, tx = this.store, questions = true) {
    const doc = await this.source(quiz, userId, tx);
    const attempts = (await tx.list("quizAttempts", { quizId: quiz.id, userId })).sort(
      (a, b) => b.id - a.id,
    );
    const { questions: raw, ...safe } = publicRow(quiz);
    return {
      ...safe,
      questionCount: quiz.questions.length,
      sourceOutdated:
        doc.activeVersionId !== quiz.versionId ||
        doc.activeIndexRevisionId !== quiz.indexRevisionId,
      latestAttempt: attempts[0] ? this.stats(attempts[0]) : null,
      ...(questions
        ? {
            questions: presentQuestions(quiz.questions),
            attempts: attempts.map((a) => this.stats(a)),
          }
        : {}),
    };
  }
  async get(id: number, userId: number) {
    return this.present(await this.owned(id, userId), userId);
  }
  async workspace(userId: number, knowledgeBaseId: number) {
    const kb = await this.store.get("knowledgeBases", knowledgeBaseId);
    if (!kb || kb.deletedAt || kb.userId !== userId) throw new ApiError(404, "知识库不存在");
    const items = [];
    for (const row of (await this.store.list("quizzes", { userId, knowledgeBaseId })).sort(
      (a, b) => b.id - a.id,
    )) {
      try {
        items.push(await this.present(row, userId, this.store, false));
      } catch (error) {
        if (!(error instanceof ApiError) || error.getStatus() !== 404) throw error;
      }
    }
    return {
      items,
      generationTasks: this.tasks
        ? (await this.tasks.list(userId, knowledgeBaseId)).filter((t) => t.kind === "quiz")
        : [],
    };
  }
  async startAttempt(quizId: number, userId: number, requestId: string) {
    const initial = await this.owned(quizId, userId);
    const id = await this.store.transaction(async (tx) => {
      // No ordinary read before the lock chain: otherwise MySQL's RR snapshot
      // could miss an attempt inserted while this request waited for these locks.
      await this.source(initial, userId, tx, true);
      const currentQuiz = await tx.lock("quizzes", quizId);
      if (!currentQuiz || currentQuiz.userId !== userId) throw new ApiError(404, "测验不存在");
      const existing = (await tx.list("quizAttempts", { userId, requestId }))[0];
      if (existing) {
        if (existing.quizId !== quizId) throw new ApiError(409, "requestId 已用于另一题集");
        return existing.id;
      }
      const row = await tx.save("quizAttempts", {
        userId,
        quizId,
        requestId,
        currentIndex: 0,
        status: "in_progress",
        answers: {},
        score: 0,
        correctCount: 0,
        answeredCount: 0,
        totalCount: currentQuiz.questions.length,
        completedAt: null,
      });
      return row.id;
    });
    return this.getAttempt(id, userId);
  }
  async getAttempt(id: number, userId: number) {
    const row = await this.store.get("quizAttempts", id);
    if (!row || row.userId !== userId) throw new ApiError(404, "练习记录不存在");
    const quiz = await this.owned(row.quizId, userId);
    return {
      ...publicRow(row),
      quiz: await this.present(quiz, userId),
      questions: presentQuestions(quiz.questions, row.answers),
    } as any;
  }
  async progress(id: number, userId: number, input: ProgressInput) {
    const initial = await this.store.get("quizAttempts", id);
    if (!initial || initial.userId !== userId) throw new ApiError(404, "练习记录不存在");
    await this.store.transaction(async (tx) => {
      const quiz = await this.owned(initial.quizId, userId, tx);
      await this.source(quiz, userId, tx, true);
      const currentQuiz = await tx.lock("quizzes", quiz.id);
      const row = await tx.lock("quizAttempts", id);
      if (!currentQuiz || !row || row.userId !== userId) throw new ApiError(404, "练习记录不存在");
      if (
        input.currentIndex !== undefined &&
        (!Number.isInteger(input.currentIndex) ||
          input.currentIndex < 0 ||
          input.currentIndex >= quiz.questions.length)
      )
        throw new ApiError(400, "题号超出范围");
      const answers: Answers = structuredClone(row.answers || {});
      if (input.questionId !== undefined) {
        const q: QuizQuestion = quiz.questions.find((q: QuizQuestion) => q.id === input.questionId);
        if (!q) throw new ApiError(400, "题目不存在");
        if (
          answers[q.id]?.submitted &&
          input.selectedOptionIds !== undefined &&
          !sameOptions(input.selectedOptionIds, answers[q.id].selectedOptionIds)
        )
          throw new ApiError(409, "已提交答案不可更改");
        if (!answers[q.id]?.submitted) {
          const selection = input.selectedOptionIds ?? answers[q.id]?.selectedOptionIds ?? [];
          if (
            !Array.isArray(selection) ||
            selection.some((id) => !OPTION_IDS.includes(id)) ||
            new Set(selection).size !== selection.length ||
            selection.length > (q.type === "SINGLE" ? 1 : 4)
          )
            throw new ApiError(400, "选项无效");
          if (input.submit && selection.length < 1) throw new ApiError(400, "请选择有效答案后提交");
          answers[q.id] = {
            selectedOptionIds: [...selection].sort(),
            submitted: !!input.submit,
            ...(input.submit
              ? { isCorrect: sameOptions(selection, q.correctOptionIds), submittedAt: now() }
              : {}),
          };
        }
      } else if (input.selectedOptionIds !== undefined || input.submit)
        throw new ApiError(400, "缺少题目标识");
      const stats = scoreAnswers(quiz.questions, answers);
      const completed = stats.answeredCount === stats.totalCount;
      await tx.save("quizAttempts", {
        id,
        answers,
        ...stats,
        currentIndex: input.currentIndex ?? row.currentIndex,
        status: completed ? "completed" : "in_progress",
        completedAt: completed ? row.completedAt || now() : null,
      });
    });
    return this.getAttempt(id, userId);
  }
  async delete(id: number, userId: number) {
    const initial = await this.owned(id, userId);
    await this.store.transaction(async (tx) => {
      await this.source(initial, userId, tx, true);
      const row = await tx.lock("quizzes", id);
      if (!row || row.userId !== userId) throw new ApiError(404, "测验不存在");
      for (const a of await tx.list("quizAttempts", { quizId: id }))
        await tx.delete("quizAttempts", a.id);
      await tx.delete("quizzes", id);
    });
    return { deleted: true };
  }
  async resolveChatContext(
    userId: number,
    context: { attemptId: number; questionId: string },
    knowledgeBaseId?: number,
  ) {
    const a = await this.getAttempt(context.attemptId, userId);
    if (knowledgeBaseId != null && knowledgeBaseId !== a.quiz.knowledgeBaseId)
      throw new ApiError(409, "解释会话不属于测验知识库");
    if (a.quiz.sourceOutdated) throw new ApiError(409, "来源已更新，当前测验不能使用 AI 解释");
    const q = a.questions.find((q: QuizQuestion) => q.id === context.questionId);
    if (!q || !a.answers[q.id]?.submitted) throw new ApiError(409, "请先提交本题再查看 AI 解释");
    return {
      knowledgeBaseId: a.quiz.knowledgeBaseId,
      documentIds: [a.quiz.documentId],
      mode: "search" as const,
      question: `我在文档测验中遇到了这道题：\n\n${q.stem}\n\n${q.options.map((o: any) => `${o.id}. ${o.text}`).join("\n")}\n\n我选择了：${a.answers[q.id].selectedOptionIds.join("、")}\n测验参考答案：${q.correctOptionIds.join("、")}\n\n请结合原文深入讲解这个主题，若参考答案/解析有误请明确指出。`,
    };
  }
}
