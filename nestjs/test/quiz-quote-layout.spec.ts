import { matchQuizQuote, normalizeQuestions } from "../src/modules/quizzes/quiz-data";
it("保存还原后的PDF原句，最终整套校验仍能逐字核对", () => {
  const source = "细胞是\n生命 的基本单位。";
  const question = {
    type: "SINGLE",
    stem: "细胞是什么？",
    options: ["A", "B", "C", "D"].map((id) => ({ id, text: `选项${id}` })),
    correctOptionIds: ["A"],
    explanation: "解析",
    optionExplanations: { A: "正确", B: "错误", C: "错误", D: "错误" },
    evidence: [{ chunkId: 1, quote: "细胞是生命的基本单位。" }],
  };
  const parsed = normalizeQuestions({ questions: [question] }, 1, 0, [{ id: 1, text: source }]);
  expect(parsed[0].evidence[0].quote).toBe(source);
  expect(() => normalizeQuestions(parsed, 1, 0, [{ id: 1, text: source }])).not.toThrow();
});
it("兼容PDF排版空白并还原真实连续原文，不改写证据", () => {
  const source = "前言。细胞是\n生命 的基本单位。后文。";
  expect(matchQuizQuote(source, "细胞是生命的基本单位。")).toBe("细胞是\n生命 的基本单位。");
  expect(matchQuizQuote("ATP\t是能量\u00a0载体。", "ATP 是能量载体。")).toBe(
    "ATP\t是能量\u00a0载体。",
  );
});
it("拒绝文字变更、省略拼接、不同标点和空引用", () => {
  const source = "细胞是生命的基本单位。";
  for (const quote of [
    "细胞是...基本单位。",
    "细胞是基本单位。",
    "细胞不是生命的基本单位。",
    "细胞是生命的基本单位!",
    "   ",
  ])
    expect(matchQuizQuote(source, quote)).toBeNull();
});
