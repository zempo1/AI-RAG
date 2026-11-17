import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { configureApp } from "../src/bootstrap";
import {
  QuizzesController,
  QuizAttemptsController,
} from "../src/modules/quizzes/quizzes.controller";
import { QuizzesService } from "../src/modules/quizzes/quizzes.service";
import { TokenizerService } from "../src/modules/embeddings/tokenizer.service";
import { pipeline } from "./helpers/pipeline";
describe("测验 HTTP 契约", () => {
  let app: INestApplication,
    p: Awaited<ReturnType<typeof pipeline>>,
    service: QuizzesService,
    documentId: number,
    quizId: number,
    attemptId: number;
  beforeAll(async () => {
    p = await pipeline();
    const file = await p.documents.ingest(Buffer.from("原文知识点"), "quiz.md", 1);
    documentId = file.documentId;
    await p.indexing.process(file.taskId);
    const chunk = (await p.store.list("chunks", { documentId }))[0];
    const config = new ConfigService({ STORAGE_DRIVER: "memory", JWT_SECRET: "x".repeat(32) });
    service = new QuizzesService(
      p.documents,
      {
        complete: async () =>
          JSON.stringify({
            questions: [
              {
                type: "SINGLE",
                stem: "测试知识点",
                options: ["A", "B", "C", "D"].map((id) => ({ id, text: `选项${id}` })),
                correctOptionIds: ["A"],
                explanation: "解析",
                optionExplanations: { A: "对", B: "错", C: "错", D: "错" },
                evidence: [{ chunkId: chunk.id, quote: "原文知识点" }],
              },
            ],
          }),
      } as any,
      p.store,
      config,
      new TokenizerService(config),
      p.tasks,
    );
    const module = await Test.createTestingModule({
      controllers: [QuizzesController, QuizAttemptsController],
      providers: [{ provide: QuizzesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.userId = Number(req.headers["x-test-user"] || 1);
      next();
    });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await p?.cleanup();
  });
  it("生成校验并202受理，未交答案完全脱敏", async () => {
    await request(app.getHttpServer())
      .post("/api/quizzes/generate")
      .send({ documentId, singleCount: 0, multipleCount: 0, requestId: randomUUID() })
      .expect(400);
    const accepted = await request(app.getHttpServer())
      .post("/api/quizzes/generate")
      .send({ documentId, singleCount: 1, multipleCount: 0, requestId: randomUUID() })
      .expect(202);
    await service.process(accepted.body.data.taskId);
    quizId = (await p.store.list("quizzes"))[0].id;
    const quiz = await request(app.getHttpServer()).get(`/api/quizzes/${quizId}`).expect(200);
    expect(JSON.stringify(quiz.body)).not.toMatch(
      /correctOptionIds|optionExplanations|explanation/,
    );
    const created = await request(app.getHttpServer())
      .post(`/api/quizzes/${quizId}/attempts`)
      .send({ requestId: randomUUID() })
      .expect(200);
    attemptId = created.body.data.id;
    expect(created.body.data.questions[0].id).toBe("q1");
  });
  it("PATCH允许跨域、恢复进度和百分制成绩，重复不同答案409", async () => {
    const cors = await request(app.getHttpServer())
      .options(`/api/quiz-attempts/${attemptId}/progress`)
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "PATCH")
      .expect(204);
    expect(cors.headers["access-control-allow-methods"]).toContain("PATCH");
    await request(app.getHttpServer())
      .patch(`/api/quiz-attempts/${attemptId}/progress`)
      .send({ questionId: "q1", selectedOptionIds: ["X"] })
      .expect(400);
    const marked = await request(app.getHttpServer())
      .patch(`/api/quiz-attempts/${attemptId}/progress`)
      .send({ questionId: "q1", selectedOptionIds: ["A"], submit: true })
      .expect(200);
    expect(marked.body.data.score).toBe(100);
    expect(marked.body.data.questions[0].correctOptionIds).toEqual(["A"]);
    expect(marked.body.data.status).toBe("completed");
    await request(app.getHttpServer())
      .patch(`/api/quiz-attempts/${attemptId}/progress`)
      .send({ questionId: "q1", selectedOptionIds: ["B"], submit: true })
      .expect(409);
    const restored = await request(app.getHttpServer())
      .get(`/api/quiz-attempts/${attemptId}`)
      .expect(200);
    expect(restored.body.data.answers.q1.isCorrect).toBe(true);
  });
  it("工作台最新成绩、所有权隔离与删除级联", async () => {
    const doc = await p.store.get("documents", documentId);
    const ws = await request(app.getHttpServer())
      .get(`/api/quizzes/workspace?knowledgeBaseId=${doc?.knowledgeBaseId}`)
      .expect(200);
    expect(ws.body.data.items[0].latestAttempt.score).toBe(100);
    expect(ws.body.data.items[0].questions).toBeUndefined();
    await request(app.getHttpServer())
      .get(`/api/quizzes/${quizId}`)
      .set("x-test-user", "2")
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/quiz-attempts/${attemptId}`)
      .set("x-test-user", "2")
      .expect(404);
    await request(app.getHttpServer()).delete(`/api/quizzes/${quizId}`).expect(200);
    await request(app.getHttpServer()).get(`/api/quiz-attempts/${attemptId}`).expect(404);
  });
});
