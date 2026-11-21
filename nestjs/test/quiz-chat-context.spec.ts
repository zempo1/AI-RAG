import { ChatController } from "../src/modules/chat/chat.controller";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ChatDto } from "../src/modules/chat/dto/chat.dto";
import { createHash } from "node:crypto";
it("普通聊天幂等指纹与既有版本保持一致", () => {
  const controller = new ChatController({} as any, {} as any, {} as any);
  const body = {
    question: "普通问题",
    chatId: 1,
    knowledgeBaseId: 2,
    documentIds: [4, 3],
    mode: "auto",
  };
  expect((controller as any).fingerprint(body)).toBe(
    createHash("sha256")
      .update(JSON.stringify([1, 2, "普通问题", [3, 4], "auto"]))
      .digest("hex"),
  );
});
it("测验权威上下文在指纹及任务受理前解析，强制唯一文档和所属库", async () => {
  let received: any;
  const quizzes: any = {
    resolveChatContext: async () => ({
      question: "权威题目：正确答案A",
      documentIds: [9],
      knowledgeBaseId: 3,
      mode: "search",
    }),
  };
  const qa: any = { lookup: async () => null };
  const history: any = {
    create: async () => ({ id: 1, knowledgeBaseId: 3, messages: [] }),
    addMessage: async () => {},
  };
  const chat: any = {
    prepare: async (question: string, _u: number, kb: number, opts: any) => {
      received = { question, kb, ...opts };
      return {};
    },
  };
  const controller = new ChatController(chat, history, qa, undefined, quizzes);
  await (controller as any).prepare(
    {
      question: "为什么",
      knowledgeBaseId: 3,
      documentIds: [44],
      mode: "general",
      quizContext: { attemptId: 1, questionId: "q1" },
    },
    1,
  );
  expect(received.question).toContain("正确答案A");
  expect(received.documentIds).toEqual([9]);
  expect(received.mode).toBe("search");
  expect(received.kb).toBe(3);
});
it("嵌套quizContext必须校验，不能在whitelist过滤中丢失", async () => {
  const valid = plainToInstance(ChatDto, {
    question: "解释",
    quizContext: { attemptId: 1, questionId: "q1" },
  });
  expect(await validate(valid, { whitelist: true })).toHaveLength(0);
  expect((valid as any).quizContext?.questionId).toBe("q1");
  const invalid = plainToInstance(ChatDto, {
    question: "解释",
    quizContext: { attemptId: -1, questionId: "" },
  });
  expect((await validate(invalid, { whitelist: true })).length).toBeGreaterThan(0);
});
it("测验聊天只保存一次服务端整理的简短题目，不追加重复的客户端模板", async () => {
  let saved = "",
    prepared = "";
  const canonical =
    "我在测验中遇到了这道题：\n题目？\nA. 选项甲\nB. 选项乙\n我的选择：A\n参考答案：B\n请结合原文深入讲解。";
  const controller = new ChatController(
    {
      prepare: async (q: string) => {
        prepared = q;
        return {};
      },
    } as any,
    {
      create: async () => ({ id: 1, knowledgeBaseId: 3, messages: [] }),
      addMessage: async (_id: number, _u: number, _role: string, content: string) => {
        saved = content;
      },
    } as any,
    { lookup: async () => null } as any,
    undefined,
    {
      resolveChatContext: async () => ({
        question: canonical,
        documentIds: [9],
        knowledgeBaseId: 3,
        mode: "search",
      }),
    } as any,
  );
  await (controller as any).prepare(
    {
      question: "客户端重复题目模板",
      quizContext: { attemptId: 1, questionId: "q1" },
      knowledgeBaseId: 3,
    },
    1,
  );
  expect(saved).toBe(canonical);
  expect(prepared).toBe(canonical);
});
it("Agent后台受理同样只持久化简短题目", async () => {
  let persisted = "";
  const agentTasks = {
    begin: async (_user: number, input: any) => {
      persisted = input.question;
      return { existing: true, task: { id: 1 } };
    },
    accepted: () => ({ taskId: 1 }),
  };
  const controller = new ChatController(
    {} as any,
    {} as any,
    {} as any,
    agentTasks as any,
    {
      resolveChatContext: async () => ({
        question: "题目与选择，请深入讲解。",
        knowledgeBaseId: 3,
        documentIds: [9],
        mode: "search",
      }),
    } as any,
  );
  await (controller as any).prepare(
    {
      question: "重复模板和不应显示的原文坐标",
      quizContext: { attemptId: 1, questionId: "q1" },
      knowledgeBaseId: 3,
    },
    1,
  );
  expect(persisted).toBe("题目与选择，请深入讲解。");
});
