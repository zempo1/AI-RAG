import { ApiError } from "../../common/api-error";
import { Row } from "../../persistence/store";
import { generationEvidenceSources } from "../documents/generation-sources";

export interface QuizQuestion {
  id: string;
  type: "SINGLE" | "MULTIPLE";
  stem: string;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  explanation: string;
  optionExplanations: Record<string, string>;
  evidence: { chunkId: number; quote: string; location?: unknown }[];
}
export interface QuizAnswer {
  selectedOptionIds: string[];
  submitted: boolean;
  isCorrect?: boolean;
  submittedAt?: string;
}
export type Answers = Record<string, QuizAnswer>;
export const OPTION_IDS = ["A", "B", "C", "D"];
export { generationEvidenceSources as quizEvidenceSources } from "../documents/generation-sources";
export class QuizValidationError extends ApiError {
  constructor(reason: string) {
    super(502, `测验校验失败：${reason}`);
  }
}
/** Match only layout whitespace differences, then retain the actual contiguous original text. */
export function matchQuizQuote(source: string, quote: string): string | null {
  const wanted = quote.trim();
  if (!wanted) return null;
  if (source.includes(wanted)) return wanted;
  const needle = wanted.replace(/\s/gu, "");
  if (!needle) return null;
  const positions: number[] = [];
  let compact = "";
  for (let index = 0; index < source.length; index++) {
    if (/\s/u.test(source[index])) continue;
    positions.push(index);
    compact += source[index];
  }
  const start = compact.indexOf(needle);
  return start < 0
    ? null
    : source.slice(positions[start], positions[start + needle.length - 1] + 1);
}
export function validateCounts(single: number, multiple: number) {
  if (
    ![single, multiple].every((n) => Number.isInteger(n) && n >= 0) ||
    single + multiple < 1 ||
    single + multiple > 20
  )
    throw new ApiError(400, "总题数须为1～20，题型数量须为非负整数");
}
export function normalizeQuestions(
  input: unknown,
  single: number,
  multiple: number,
  chunks: Row[],
  previous: QuizQuestion[] = [],
): QuizQuestion[] {
  validateCounts(single, multiple);
  let value: any = input;
  try {
    if (typeof value === "string")
      value = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new QuizValidationError("模型返回的 JSON 格式无效");
  }
  if (!Array.isArray(value)) value = value?.questions;
  const invalid = (reason = "题目字段不完整或类型无效") => {
    throw new QuizValidationError(reason);
  };
  if (!Array.isArray(value) || value.length !== single + multiple)
    return invalid("题目数量与请求不一致");
  let singles = 0;
  const sources = new Map(
    generationEvidenceSources(chunks).map((source) => [source.sourceId, source]),
  );
  const seen = new Set(previous.map((q) => q.stem.replace(/[\s\p{P}]/gu, "").toLowerCase()));
  const result = value.map((q: any, index: number): QuizQuestion => {
    if (
      !q ||
      !["SINGLE", "MULTIPLE"].includes(q.type) ||
      typeof q.stem !== "string" ||
      !q.stem.trim() ||
      q.stem.length > 3000
    )
      return invalid();
    const stem = q.stem.trim();
    const key = stem.replace(/[\s\p{P}]/gu, "").toLowerCase();
    if (seen.has(key)) return invalid("题干与已生成的题目重复");
    seen.add(key);
    if (q.type === "SINGLE") singles++;
    if (!Array.isArray(q.options) || q.options.length !== 4)
      return invalid("每题必须包含 A～D 四个选项");
    const options = OPTION_IDS.map((id) => {
      const o = q.options.find((v: any) => v?.id === id);
      if (typeof o?.text !== "string" || !o.text.trim() || o.text.length > 3000) return invalid();
      return { id, text: o.text.trim() };
    });
    if (new Set(options.map((o) => o.text)).size !== 4) return invalid("同一题存在重复选项");
    const correct = q.correctOptionIds;
    if (
      !Array.isArray(correct) ||
      correct.some((id: any) => !OPTION_IDS.includes(id)) ||
      new Set(correct).size !== correct.length ||
      (q.type === "SINGLE" ? correct.length !== 1 : correct.length < 2 || correct.length > 3)
    )
      return invalid("正确选项编号或数量不符合题型要求");
    if (typeof q.explanation !== "string" || !q.explanation.trim() || q.explanation.length > 6000)
      return invalid("缺少有效的题目解析");
    const optionExplanations: Record<string, string> = {};
    for (const id of OPTION_IDS) {
      const text = q.optionExplanations?.[id];
      if (typeof text !== "string" || !text.trim() || text.length > 3000)
        return invalid("缺少 A～D 逐项解析");
      optionExplanations[id] = text.trim();
    }
    if (!Array.isArray(q.evidence) || !q.evidence.length || q.evidence.length > 4)
      return invalid("每题须提供 1～4 段原文证据");
    const evidence = q.evidence.map((e: any) => {
      if (typeof e?.sourceId === "string") {
        const source = sources.get(e.sourceId);
        if (!source) return invalid("引用的来源片段编号不属于本批资料");
        return { chunkId: source.chunkId, quote: source.text, location: source.location };
      }
      const chunk = chunks.find((c) => c.id === e?.chunkId);
      if (!chunk || typeof e.quote !== "string" || !e.quote.trim() || e.quote.length > 3000)
        return invalid("引用编号或原文不匹配，须连续逐字引用，不得改写、拼接或省略");
      const quote = matchQuizQuote(String(chunk.text), e.quote);
      if (quote === null) return invalid("引用原文不匹配，须连续引用，不得改写、拼接或省略");
      return { chunkId: chunk.id, quote, location: chunk.location ?? null };
    });
    return {
      id: `q${previous.length + index + 1}`,
      type: q.type,
      stem,
      options,
      correctOptionIds: [...correct].sort(),
      explanation: q.explanation.trim(),
      optionExplanations,
      evidence,
    };
  });
  if (singles !== single) return invalid("单选与多选的题型配比不正确");
  return result;
}
export function sameOptions(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
}
export function scoreAnswers(questions: QuizQuestion[], answers: Answers) {
  const answeredCount = questions.filter((q) => answers[q.id]?.submitted).length;
  const correctCount = questions.filter(
    (q) =>
      answers[q.id]?.submitted && sameOptions(answers[q.id].selectedOptionIds, q.correctOptionIds),
  ).length;
  return {
    answeredCount,
    correctCount,
    totalCount: questions.length,
    score: questions.length ? Math.round((correctCount * 10000) / questions.length) / 100 : 0,
  };
}
export function presentQuestions(questions: QuizQuestion[], answers: Answers = {}) {
  return questions.map((q) => {
    const { correctOptionIds, explanation, optionExplanations, ...safe } = q;
    return answers[q.id]?.submitted
      ? { ...safe, correctOptionIds, explanation, optionExplanations }
      : safe;
  });
}
