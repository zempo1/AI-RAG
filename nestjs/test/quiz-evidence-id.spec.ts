import { normalizeQuestions, quizEvidenceSources } from "../src/modules/quizzes/quiz-data";
const chunks = [{ id: 71, text: "细胞是\n生命的基本单位。", location: { page: 2 } }];
const question = (evidence: any[]) => ({
  type: "SINGLE",
  stem: "什么是基本单位？",
  options: ["A", "B", "C", "D"].map((id) => ({ id, text: id })),
  correctOptionIds: ["A"],
  explanation: "解析",
  optionExplanations: { A: "对", B: "错", C: "错", D: "错" },
  evidence,
});
it("模型只选择片段编号，原文由服务端填入，不依赖模型重新抄写", () => {
  const sources = quizEvidenceSources(chunks);
  const result = normalizeQuestions(
    { questions: [question([{ sourceId: sources[0].sourceId }])] },
    1,
    0,
    chunks,
  );
  expect(result[0].evidence).toEqual([
    { chunkId: 71, quote: chunks[0].text, location: { page: 2 } },
  ]);
  expect(() => normalizeQuestions(result, 1, 0, chunks)).not.toThrow();
});
it("拒绝编造或来自本批之外的编号", () => {
  expect(() =>
    normalizeQuestions({ questions: [question([{ sourceId: "s999_0" }])] }, 1, 0, chunks),
  ).toThrow();
});
it("切分保留全部原文字段，每段有稳定编号且长度受限", () => {
  const text = "甲".repeat(1500) + "\n末尾的关键事实";
  const sources = quizEvidenceSources([{ id: 99, text }]);
  expect(sources.map((s) => s.text).join("")).toBe(text);
  expect(sources.every((s) => s.text.length <= 600)).toBe(true);
  expect(new Set(sources.map((s) => s.sourceId)).size).toBe(sources.length);
});
