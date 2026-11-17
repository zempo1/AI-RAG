import test from "node:test";
import assert from "node:assert/strict";
import { resolveQuizCounts, buildQuizExplanation } from "../src/features/quiz/quiz-state.ts";

test("quiz counts preserve an integer custom ratio and reject empty/mixed one-question configuration", () => {
  assert.deepEqual(resolveQuizCounts(10, ["SINGLE", "MULTIPLE"], 0.6), {
    singleCount: 6,
    multipleCount: 4,
  });
  assert.deepEqual(resolveQuizCounts(11, ["SINGLE", "MULTIPLE"], 0.5), {
    singleCount: 6,
    multipleCount: 5,
  });
  assert.deepEqual(resolveQuizCounts(20, ["MULTIPLE"], 0.9), { singleCount: 0, multipleCount: 20 });
  assert.throws(() => resolveQuizCounts(1, ["SINGLE", "MULTIPLE"], 0.5));
  assert.throws(() => resolveQuizCounts(10, [], 0.5));
  assert.throws(() => resolveQuizCounts(21, ["SINGLE"], 0.5));
});
test("explanation includes full options, actual selection and reference answer without asserting model correctness", () => {
  const question = {
    id: "q1",
    stem: "定义是什么？",
    options: [
      { id: "A", text: "定义一" },
      { id: "B", text: "定义二" },
    ],
    correctOptionIds: ["B"],
  };
  const text = buildQuizExplanation(question, { selectedOptionIds: ["A"], submitted: true });
  assert.match(text, /A\. 定义一/);
  assert.match(text, /B\. 定义二/);
  assert.match(text, /我选择了：A/);
  assert.match(text, /参考答案：B/);
  assert.match(text, /核对/);
});
