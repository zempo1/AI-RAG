export function resolveQuizCounts(total: number, types: readonly string[], singleRatio = 0.5) {
  if (!Number.isInteger(total) || total < 1 || total > 20)
    throw new Error("题目数量应为 1～20 的整数");
  const single = types.includes("SINGLE"),
    multiple = types.includes("MULTIPLE");
  if (!single && !multiple) throw new Error("请至少选择一种题型");
  if (single && multiple && total < 2) throw new Error("混合测验至少需要 2 道题");
  const singleCount = single
    ? multiple
      ? Math.min(total - 1, Math.max(1, Math.round(total * singleRatio)))
      : total
    : 0;
  return { singleCount, multipleCount: total - singleCount };
}
export function buildQuizExplanation(
  question: { stem: string; options: { id: string; text: string }[]; correctOptionIds?: string[] },
  answer: { selectedOptionIds: string[] },
) {
  return `我在文档测验中遇到了这道题：\n\n${question.stem}\n\n${question.options.map((option) => `${option.id}. ${option.text}`).join("\n")}\n\n我选择了：${answer.selectedOptionIds.join("、")}\n测验参考答案：${question.correctOptionIds?.join("、") || "见判题结果"}\n\n请结合原文深入讲解这个主题，核对参考答案，若参考答案/解析有误请明确指出。`;
}
