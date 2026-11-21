import { expect, type Page } from "@playwright/test";
const questions = [
  {
    id: "q1",
    type: "SINGLE",
    stem: "数据链路层的主要功能是什么？",
    options: [
      { id: "A", text: "在相邻节点之间可靠传输数据帧" },
      { id: "B", text: "为应用提供文件传输" },
      { id: "C", text: "确定全网路由" },
      { id: "D", text: "将域名解析为地址" },
    ],
    correctOptionIds: ["A"],
  },
  {
    id: "q2",
    type: "MULTIPLE",
    stem: "下列哪些机制与数据链路层有关？",
    options: [
      { id: "A", text: "帧同步" },
      { id: "B", text: "差错检测" },
      { id: "C", text: "域名解析" },
      { id: "D", text: "应用程序认证" },
    ],
    correctOptionIds: ["A", "B"],
  },
].map((question) => ({
  ...question,
  explanation: "资料说明了帧传输、帧同步和差错检测。",
  optionExplanations: {
    A: "此机制直接对应文档描述的链路层功能。",
    B: "请结合题干区分层次与机制。",
    C: "该选项属于其他层次的功能。",
    D: "该选项不属于链路层。",
  },
  evidence: [
    {
      chunkId: 71,
      quote: "数据链路层在相邻节点之间传输数据帧，提供帧同步和差错检测。",
      location: { page: null, paragraph: 1, heading: "数据链路层", start: 0, end: 35 },
    },
  ],
}));
export async function quizFixture(page: Page) {
  let attempt: any = null,
    attemptId = 100,
    generated = false;
  const attempts = new Map<number, any>();
  const quiz: any = {
    id: 21,
    knowledgeBaseId: 1,
    documentId: 7,
    versionId: 1,
    indexRevisionId: 1,
    title: "网络原理 · 智能测验",
    filename: "网络原理.md",
    singleCount: 1,
    multipleCount: 1,
    questionCount: 2,
    createdAt: "2026-11-17T10:00:00",
    sourceOutdated: false,
  };
  const redact = (question: any, reveal = false) => {
    const { correctOptionIds, explanation, optionExplanations, ...publicPart } = question;
    return reveal ? question : publicPart;
  };
  const quizView = () => ({
    ...quiz,
    questions: questions.map((q) => redact(q)),
    attempts: [...attempts.values()]
      .reverse()
      .map((value) => ({ ...value, quiz: undefined, questions: undefined, answers: undefined })),
    latestAttempt: attempt
      ? { ...attempt, quiz: undefined, questions: undefined, answers: undefined }
      : null,
  });
  const attemptView = (record = attempt) => ({
    ...record,
    quiz: quizView(),
    questions: questions.map((q) => redact(q, !!record.answers[q.id]?.submitted)),
  });
  const state = {
    streamRequests: [] as any[],
    generationRequests: [] as any[],
    failSave: false,
    quiz,
    readOnly: false,
    sourceReady: true,
    attempt: () => attempt,
  };
  await page.addInitScript(() => {
    localStorage.setItem("token", "test-token");
    localStorage.setItem("username", "alice");
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      let data: any = [];
      if (path === "/api/knowledge-bases")
        data = [{ id: 1, name: "测试知识库", rebuildTaskId: null }];
      else if (path === "/api/knowledge-bases/1/documents")
        data = {
          items: [
            {
              id: 7,
              filename: "网络原理.md",
              knowledgeBaseId: 1,
              activeVersionId: 1,
              activeIndexRevisionId: 1,
              status: state.sourceReady ? "ready" : "queued",
              categoryId: null,
              uploadTime: "2026-11-17T10:00:00",
            },
          ],
          total: 1,
        };
      else if (path === "/api/documents")
        data = [{ id: 7, filename: "网络原理.md", knowledgeBaseId: 1, status: "ready" }];
      else if (path === "/api/quizzes/workspace")
        data = {
          items: [quizView()],
          generationTasks: generated
            ? [
                {
                  id: 81,
                  kind: "quiz",
                  status: "running",
                  stage: "generating",
                  completed: 1,
                  total: 2,
                  filename: quiz.filename,
                },
              ]
            : [],
        };
      else if (path === "/api/quizzes/generate") {
        state.generationRequests.push(route.request().postDataJSON());
        generated = true;
        return route.fulfill({ status: 202, json: { data: { taskId: 81, status: "queued" } } });
      } else if (path === "/api/tasks/81")
        data = {
          id: 81,
          kind: "quiz",
          status: "completed",
          stage: "completed",
          quizResult: { quizId: 21 },
        };
      else if (path === "/api/quizzes/21") data = quizView();
      else if (path === "/api/quizzes/21/attempts") {
        attempt = {
          id: ++attemptId,
          quizId: 21,
          currentIndex: 0,
          status: "in_progress",
          answers: {},
          score: 0,
          correctCount: 0,
          answeredCount: 0,
          totalCount: 2,
          createdAt: "2026-11-17T10:01:00",
          completedAt: null,
        };
        attempts.set(attempt.id, attempt);
        data = attemptView();
      } else if (/^\/api\/quiz-attempts\/\d+(?:\/progress)?$/.test(path)) {
        const record = attempts.get(Number(path.split("/")[3])) || attempt;
        if (method === "PATCH") {
          if (state.failSave)
            return route.fulfill({ status: 503, json: { message: "测试网络暂不可用" } });
          const body = route.request().postDataJSON();
          if (body.currentIndex !== undefined) record.currentIndex = body.currentIndex;
          if (body.questionId) {
            const q = questions.find((q) => q.id === body.questionId)!;
            record.answers[q.id] = {
              selectedOptionIds: body.selectedOptionIds,
              submitted: !!body.submit,
              ...(body.submit
                ? {
                    isCorrect:
                      [...body.selectedOptionIds].sort().join() === q.correctOptionIds.join(),
                  }
                : {}),
            };
          }
          record.answeredCount = Object.values(record.answers).filter(
            (a: any) => a.submitted,
          ).length;
          record.correctCount = Object.values(record.answers).filter(
            (a: any) => a.isCorrect,
          ).length;
          record.score = (record.correctCount / 2) * 100;
          if (record.answeredCount === 2) record.status = "completed";
        }
        data = attemptView(record);
      } else if (path === "/api/stream-chat") {
        state.streamRequests.push(route.request().postDataJSON());
        return route.fulfill({
          contentType: "text/event-stream",
          body:
            "event: done\ndata: " +
            JSON.stringify({
              answer: "根据原文，数据链路层负责相邻节点间的帧传输。",
              citations: [],
              chatId: 9,
              generationStatus: "completed",
            }) +
            "\n\n",
        });
      } else if (path === "/api/documents/7/preview")
        data = {
          documentId: 7,
          versionId: 1,
          filename: quiz.filename,
          mimeType: "text/markdown",
          text: "数据链路层在相邻节点之间传输数据帧。",
          originalAvailable: false,
        };
      await route.fulfill({ json: { data } });
    },
  );
  await page.goto("/");
  await expect(page.getByPlaceholder("发送消息...")).toBeEnabled();
  await page.locator(".wb-tab").getByText("智能测验", { exact: true }).click();
  await expect(page.getByText("网络原理 · 智能测验", { exact: true })).toBeVisible();
  return state;
}
export async function openQuiz(page: Page) {
  await page.getByRole("button", { name: "开始练习", exact: true }).click();
  await expect(page.locator(".quiz-question-stem")).toBeVisible();
}
