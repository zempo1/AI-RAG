import { ConfigService } from "@nestjs/config";
import { ApiError } from "../../common/api-error";
import { LlmService } from "../llm/llm.service";
import { ModelExecutionOptions, ModelOutputError } from "../llm/llm.types";
import { MindMapData, parseModelMap } from "./mindmap-data";
import { MindMapPhase, MindMapPlan, MindMapPlanner } from "./mindmap-planner";
import { assembleMindMap, catalogNotes, parseOrganization } from "./mindmap-assembly";

export interface MindMapNotes {
  topics: { topic: string; points: string[] }[];
}
class MindMapFormatError extends ApiError {
  constructor() {
    super(502, "模型返回的 JSON 结构不符合要求");
  }
}
export interface GenerationContext {
  signal: AbortSignal;
  abort(error: unknown): void;
  guard(): Promise<void>;
  apiKey?: string;
  title?: string;
  onAttempt: ModelExecutionOptions["onAttempt"];
  progress(stage: string, completed?: number, total?: number): Promise<void>;
  cache<T>(
    phase: MindMapPhase,
    input: string,
    make: () => Promise<T>,
    parse: (value: unknown) => T,
  ): Promise<T>;
  failed(count: number): Promise<void>;
}
export function parseNotes(value: unknown): MindMapNotes {
  let data: any = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new ApiError(502, "精简要点JSON无效");
    }
  }
  if (!Array.isArray(data?.topics) || !data.topics.length || data.topics.length > 300)
    throw new ApiError(502, "精简要点结构无效");
  return {
    topics: data.topics.map((topic: any) => {
      if (
        typeof topic?.topic !== "string" ||
        !topic.topic.trim() ||
        !Array.isArray(topic.points) ||
        !topic.points.length ||
        topic.points.length > 300 ||
        topic.points.some((p: unknown) => typeof p !== "string" || !p.trim())
      )
        throw new ApiError(502, "精简要点结构无效");
      return { topic: topic.topic, points: topic.points };
    }),
  };
}
export class MindMapGenerator {
  constructor(
    private readonly config: ConfigService,
    private readonly planner: MindMapPlanner,
    private readonly llm: LlmService,
  ) {}
  private failureReason(error: any) {
    if (error instanceof MindMapFormatError) return "模型返回的 JSON 结构不符合要求";
    if (error instanceof ModelOutputError)
      return error.reason === "length" ? "模型输出达到长度上限" : "模型返回空内容或无效内容";
    const status = Number(error?.getStatus?.() ?? error?.status);
    if (status === 429) return "模型请求受到限流";
    if (status >= 500 && status <= 599) return "模型服务暂时不可用";
    if (error?.name === "TimeoutError" || error?.name === "APIConnectionTimeoutError")
      return "模型请求超时";
    return "模型请求失败";
  }
  private fatal(error: any, ctx: GenerationContext) {
    return (
      ctx.signal.aborted ||
      [401, 403, 404, 409].includes(Number(error?.getStatus?.() ?? error?.status))
    );
  }
  private async check(ctx: GenerationContext) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      await ctx.guard();
    } catch (error) {
      ctx.abort(error);
      throw error;
    }
  }
  private async call(phase: MindMapPhase, input: string, ctx: GenerationContext, repair = false) {
    await this.planner.assertFits(phase, input, repair);
    for (let retry = 0; ; retry++) {
      await this.check(ctx);
      try {
        return await this.llm.complete(
          this.planner.prompt(phase, input, repair),
          ctx.apiKey,
          [],
          undefined,
          {
            json: true,
            thinking: false,
            role: "chat",
            signal: ctx.signal,
            maxOutputTokens: this.planner.output(phase),
            onAttempt: ctx.onAttempt,
          },
        );
      } catch (error: any) {
        if (this.fatal(error, ctx)) {
          ctx.abort(error);
          throw error;
        }
        if (Number(error?.status ?? error?.getStatus?.()) !== 429 || retry >= 2) throw error;
        const headers = error?.headers ?? error?.response?.headers;
        const value = headers?.get?.("retry-after") ?? headers?.["retry-after"];
        const milliseconds =
          error.retryAfterMs ??
          (value == null
            ? 250 * 2 ** retry
            : /^\d+(\.\d+)?$/.test(String(value))
              ? Number(value) * 1000
              : Date.parse(value) - Date.now());
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 10000)
          throw new ApiError(429, "模型限流，请稍后重试");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(ctx.signal.reason);
          };
          const timer = setTimeout(() => {
            ctx.signal.removeEventListener("abort", abort);
            resolve();
          }, milliseconds);
          ctx.signal.addEventListener("abort", abort, { once: true });
          if (ctx.signal.aborted) abort();
        });
      }
    }
  }
  private generateValue<T>(
    phase: MindMapPhase,
    input: string,
    ctx: GenerationContext,
    parse: (value: any) => T,
  ) {
    return ctx.cache(
      phase,
      input,
      async () => {
        const response = await this.call(phase, input, ctx);
        try {
          return parse(response);
        } catch {
          await this.check(ctx);
          // Only a successful response with invalid structure gets this one repair attempt.
          const repaired = await this.call(phase, input, ctx, true);
          try {
            return parse(repaired);
          } catch {
            throw new MindMapFormatError();
          }
        }
      },
      parse,
    );
  }
  async generate(plan: MindMapPlan, ctx: GenerationContext): Promise<MindMapData> {
    if (plan.strategy === "direct") {
      await ctx.progress("generating");
      try {
        return await this.generateValue("direct", plan.batches[0], ctx, (value) =>
          parseModelMap(typeof value === "string" ? value : JSON.stringify(value)),
        );
      } catch (error) {
        if (!(error instanceof ModelOutputError) || error.reason !== "length") throw error;
        await this.check(ctx);
        // A bounded direct response may still truncate. Reuse the same source through extraction.
        return this.generate(
          { strategy: "batched", batches: await this.planner.pack(plan.batches, "extract") },
          ctx,
        );
      }
    }
    await ctx.progress("mapping", 0, plan.batches.length);
    const values = new Array<MindMapNotes>(plan.batches.length);
    let cursor = 0,
      completed = 0,
      failures = 0;
    let fatal: unknown;
    const failureReasons = new Set<string>();
    const worker = async () => {
      while (cursor < plan.batches.length && !ctx.signal.aborted) {
        await this.check(ctx);
        if (ctx.signal.aborted) break;
        const index = cursor++;
        if (index >= plan.batches.length) break;
        try {
          values[index] = await this.generateValue("extract", plan.batches[index], ctx, parseNotes);
          await ctx.progress("mapping", ++completed, plan.batches.length);
        } catch (error) {
          if (this.fatal(error, ctx)) {
            fatal = error;
            ctx.abort(error);
            throw error;
          }
          await this.check(ctx);
          failureReasons.add(this.failureReason(error));
          await ctx.failed(++failures);
        }
      }
    };
    const concurrency = Math.max(
      1,
      Math.min(4, Number(this.config.get("MINDMAP_CONCURRENCY") || 3)),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, plan.batches.length) }, worker),
    );
    if (ctx.signal.aborted) throw fatal ?? ctx.signal.reason;
    const rejected = outcomes.find((value) => value.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    if (failures)
      throw new ApiError(
        502,
        `${failures} 个批次提炼失败：${[...failureReasons].sort().join("；")}。` +
          (completed ? `${completed} 个成功批次已缓存，重试将复用` : "尚无成功批次，请重试"),
      );
    await ctx.progress("merging");
    const catalog = catalogNotes(values);
    // Send titles and IDs only. Facts never need to be generated or transmitted again.
    const input = JSON.stringify(catalog.map(({ id, topic }) => ({ id, topic })));
    if (catalog.length <= 140 && (await this.planner.fits("organize", input, true))) {
      try {
        const organization = await this.generateValue("organize", input, ctx, (value) =>
          parseOrganization(value, catalog),
        );
        await this.check(ctx);
        return assembleMindMap(catalog, organization, ctx.title);
      } catch (error) {
        await this.check(ctx);
        if (!(error instanceof MindMapFormatError) && !(error instanceof ModelOutputError))
          throw error;
      }
    }
    await this.check(ctx);
    return assembleMindMap(catalog, undefined, ctx.title);
  }
}
