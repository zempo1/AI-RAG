import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../../common/api-error";
import { Store, Row, now } from "../../persistence/store";
import { TokenizerService } from "../embeddings/tokenizer.service";
import { LlmService, ModelAttemptEvent } from "../llm/llm.service";
import {
  bindingIdentity,
  modelBinding,
  redactModelError,
  runWithTaskModels,
} from "../model-settings/model-runtime";
import { openQaCredential } from "../tasks/qa-credentials";
import { terminalTask } from "../tasks/tasks.service";
import { normalizeMindMap } from "./mindmap-data";
import { MindMapGenerator } from "./mindmap-generator";
import { MINDMAP_PROMPT_VERSION, MindMapPlanner, mindMapCacheVersion } from "./mindmap-planner";

const LEASE = 300000;
interface Progress {
  strategy: "direct" | "batched";
  modelCalls: number;
  cacheHits: number;
  startedAt: string;
  elapsedMs: number;
  failedBatches: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageReportedCalls: number;
  usageMissingCalls: number;
  usageScope: "pipeline";
}

/** Owns one leased execution. Source, cache and result commits use the same lock order. */
export class MindMapRunner {
  private readonly logger = new Logger(MindMapRunner.name);
  constructor(
    private readonly store: Store,
    private readonly llm: LlmService,
    private readonly config: ConfigService,
    private readonly tokenizer: TokenizerService,
  ) {}

  private async verify(task: Row, token: string, tx = this.store, lock = false) {
    const read = (table: "knowledgeBases" | "documents" | "tasks", id: number) =>
      lock ? tx.lock(table, id) : tx.get(table, id);
    const kb = await read("knowledgeBases", task.knowledgeBaseId);
    const doc = await read("documents", task.documentId);
    const current = await read("tasks", task.id);
    if (
      !kb ||
      kb.deletedAt ||
      kb.userId !== task.userId ||
      !doc ||
      doc.deletedAt ||
      doc.userId !== task.userId ||
      doc.knowledgeBaseId !== task.knowledgeBaseId
    )
      throw new ApiError(404, "来源已删除或授权已失效");
    if (
      doc.activeVersionId !== task.payload.versionId ||
      doc.activeIndexRevisionId !== task.indexRevisionId
    )
      throw new ApiError(409, "文档或索引已更新，请重新生成");
    const revision = await tx.get("indexRevisions", task.indexRevisionId);
    if (
      !revision ||
      revision.documentId !== doc.id ||
      revision.versionId !== task.payload.versionId
    )
      throw new ApiError(409, "来源索引不可用，请重新生成");
    if (!current || current.status !== "running" || current.executionToken !== token)
      throw new ApiError(409, "任务已取消或执行权已变化");
    return current;
  }

  async process(id: number, attempt = 1, report?: (value: object) => Promise<void>) {
    const initial = await this.store.get("tasks", id);
    if (!initial || initial.kind !== "mindmap" || terminalTask(initial.status)) return "done";
    return runWithTaskModels(
      this.config,
      { userId: initial.userId, payload: initial.payload },
      async () => {
        const token = randomUUID();
        const task = await this.store.transaction(async (tx) => {
          const row = await tx.lock("tasks", id);
          if (
            !row ||
            terminalTask(row.status) ||
            (row.executionToken && row.payload?.leaseUntil > Date.now())
          )
            return null;
          return tx.save("tasks", {
            id,
            status: "running",
            stage: "reading",
            completed: 0,
            total: null,
            attempts: attempt,
            executionToken: token,
            updatedAt: now(),
            payload: {
              ...row.payload,
              leaseUntil: Date.now() + LEASE,
              pipelineVersion: MINDMAP_PROMPT_VERSION,
              usageExecutionToken: token,
            },
          });
        });
        if (!task) return "waiting";
        const controller = new AbortController();
        const abort = (error: unknown) => {
          if (!controller.signal.aborted) controller.abort(error);
        };
        const guard = async () => {
          controller.signal.throwIfAborted();
          await this.verify(task, token);
        };
        const previous =
          initial.payload?.pipelineVersion === MINDMAP_PROMPT_VERSION
            ? initial.payload?.mindmapProgress
            : null;
        const metrics: Progress = {
          strategy: "direct",
          modelCalls: previous?.modelCalls || 0,
          cacheHits: previous?.cacheHits || 0,
          startedAt: previous?.startedAt || new Date().toISOString(),
          elapsedMs: 0,
          failedBatches: 0,
          inputTokens: previous?.inputTokens ?? 0,
          outputTokens: previous?.outputTokens ?? 0,
          totalTokens: previous?.totalTokens ?? 0,
          usageReportedCalls: previous?.usageReportedCalls ?? 0,
          // Starts without a persisted end (including older tasks) have unknown usage.
          usageMissingCalls: Math.max(
            previous?.usageMissingCalls ?? 0,
            (previous?.modelCalls ?? 0) - (previous?.usageReportedCalls ?? 0),
          ),
          usageScope: "pipeline",
        };
        let stage = "reading";
        let processedSections: number | undefined;
        const persist = async (nextStage?: string, completed?: number, total?: number) => {
          if (nextStage === "mapping" && total !== undefined) {
            processedSections = total;
            metrics.strategy = "batched";
          }
          await guard();
          await this.store.transaction(async (tx) => {
            const current = await this.verify(task, token, tx, true);
            const next = nextStage || current.stage;
            metrics.elapsedMs = Math.max(0, Date.now() - Date.parse(metrics.startedAt));
            const count =
              next === "mapping"
                ? Math.max(current.stage === next ? current.completed : 0, completed || 0)
                : 0;
            await tx.save("tasks", {
              id,
              stage: next,
              completed: count,
              total: next === "mapping" ? (total ?? current.total) : null,
              updatedAt: now(),
              payload: {
                ...current.payload,
                leaseUntil: Date.now() + LEASE,
                mindmapProgress: { ...metrics },
              },
            });
          });
          if (nextStage) {
            stage = nextStage;
            await report?.({
              stage: nextStage,
              completed: nextStage === "mapping" ? completed || 0 : 0,
              total: nextStage === "mapping" ? total : null,
            });
          }
        };
        let checking: Promise<void> | undefined;
        const cancellation = setInterval(() => {
          if (checking) return;
          checking = guard()
            .catch(abort)
            .finally(() => {
              checking = undefined;
            });
        }, 1000);
        cancellation.unref();
        const heartbeat = setInterval(() => {
          void this.store
            .transaction(async (tx) => {
              const current = await tx.lock("tasks", id);
              if (current?.executionToken === token && current.status === "running")
                await tx.save("tasks", {
                  id,
                  payload: { ...current.payload, leaseUntil: Date.now() + LEASE },
                });
            })
            .catch(abort);
        }, 30000);
        heartbeat.unref();
        try {
          await guard();
          const planner = new MindMapPlanner(this.config, this.tokenizer);
          const chunks = (
            await this.store.list("chunks", { indexRevisionId: task.indexRevisionId })
          ).filter(
            (chunk) =>
              chunk.documentId === task.documentId && chunk.versionId === task.payload.versionId,
          );
          const plan = await planner.plan(chunks);
          metrics.strategy = plan.strategy;
          await persist("reading");
          const cache = async <T>(
            phase: string,
            input: string,
            make: () => Promise<T>,
            parse: (value: unknown) => T,
          ): Promise<T> => {
            await guard();
            const cacheKey = createHash("sha256")
              .update(
                JSON.stringify([
                  mindMapCacheVersion(phase),
                  task.userId,
                  task.knowledgeBaseId,
                  task.documentId,
                  task.payload.versionId,
                  task.indexRevisionId,
                  bindingIdentity(modelBinding(this.config, "chat")),
                  phase,
                  input,
                ]),
              )
              .digest("hex");
            const query = { userId: task.userId, knowledgeBaseId: task.knowledgeBaseId, cacheKey };
            const existing = (await this.store.list("summaryCaches", query))[0]?.payload;
            if (
              existing?.promptVersion === mindMapCacheVersion(phase) &&
              existing.phase === phase
            ) {
              let value: T | undefined;
              try {
                value = parse(existing.value);
              } catch {
                /* Invalid cache is regenerated. */
              }
              if (value !== undefined) {
                metrics.cacheHits++;
                await persist();
                return value;
              }
            }
            const value = await make();
            await this.store.transaction(async (tx) => {
              await this.verify(task, token, tx, true);
              try {
                await tx.save("summaryCaches", {
                  ...query,
                  indexRevisionId: task.indexRevisionId,
                  payload: { promptVersion: mindMapCacheVersion(phase), phase, value },
                });
              } catch (error: any) {
                if (error?.code !== "ER_DUP_ENTRY" && error?.getStatus?.() !== 409) throw error;
              }
            });
            return value;
          };
          const onAttempt = async (event: ModelAttemptEvent) => {
            if (event.phase === "start") {
              await guard();
              metrics.modelCalls++;
              await persist();
            } else {
              const usage = event.usage;
              if (
                usage &&
                [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(
                  (value) => Number.isFinite(value) && value >= 0,
                )
              ) {
                metrics.inputTokens += usage.inputTokens;
                metrics.outputTokens += usage.outputTokens;
                metrics.totalTokens += usage.totalTokens;
                metrics.usageReportedCalls++;
              } else metrics.usageMissingCalls++;
              this.logger.log(
                JSON.stringify({
                  event: "mindmap-model-attempt",
                  taskId: id,
                  stage,
                  status: event.status,
                  elapsedMs: Math.round(event.elapsedMs),
                  usage: event.usage,
                }),
              );
              // Cancellation revokes publishing authority, but the same execution must
              // still settle billed usage. A replacement execution has a different token.
              await this.store.transaction(async (tx) => {
                const current = await tx.lock("tasks", id);
                if (!current || current.payload?.usageExecutionToken !== token) return;
                if (current.executionToken !== token && current.status !== "canceled") return;
                metrics.elapsedMs = Math.max(0, Date.now() - Date.parse(metrics.startedAt));
                await tx.save("tasks", {
                  id,
                  payload: { ...current.payload, mindmapProgress: { ...metrics } },
                });
              });
            }
          };
          const generator = new MindMapGenerator(this.config, planner, this.llm);
          const result = await generator.generate(plan, {
            title: String(task.payload.filename || "文档知识要点").replace(/\.[^.]+$/, ""),
            signal: controller.signal,
            abort,
            guard,
            cache,
            onAttempt,
            apiKey: openQaCredential(this.config.getOrThrow("JWT_SECRET"), task.payload.credential),
            progress: persist,
            failed: async (count) => {
              metrics.failedBatches = count;
              await persist();
            },
          });
          await persist("validating");
          const data = normalizeMindMap(result, { nodes: 300, depth: 5 });
          const coverage = {
            totalSections: processedSections ?? plan.batches.length,
            completedSections: processedSections ?? plan.batches.length,
            complete: true,
          };
          data.meta = {
            ...data.meta,
            source: {
              documentId: task.documentId,
              versionId: task.payload.versionId,
              indexRevisionId: task.indexRevisionId,
            },
            coverage,
            promptVersion: MINDMAP_PROMPT_VERSION,
            usage: {
              inputTokens: metrics.inputTokens,
              outputTokens: metrics.outputTokens,
              totalTokens: metrics.totalTokens,
              usageReportedCalls: metrics.usageReportedCalls,
              usageMissingCalls: metrics.usageMissingCalls,
              usageScope: metrics.usageScope,
            },
          };
          await this.store.transaction(async (tx) => {
            const current = await this.verify(task, token, tx, true);
            controller.signal.throwIfAborted();
            const map = await tx.save("mindmaps", {
              userId: task.userId,
              documentId: task.documentId,
              versionId: task.payload.versionId,
              title: `${task.payload.filename} · 思维导图`,
              data: JSON.stringify(data),
            });
            metrics.elapsedMs = Date.now() - Date.parse(metrics.startedAt);
            await tx.save("tasks", {
              id,
              status: "completed",
              stage: "completed",
              completed: 0,
              total: null,
              executionToken: null,
              error: null,
              updatedAt: now(),
              payload: {
                ...current.payload,
                leaseUntil: null,
                credential: null,
                modelSnapshot: null,
                mindmapProgress: { ...metrics },
                mindmapResult: { mindMapId: map.id, coverage },
              },
            });
          });
        } catch (caught) {
          const error = controller.signal.aborted ? controller.signal.reason : caught;
          const safe = redactModelError(
            this.config,
            error,
            openQaCredential(this.config.getOrThrow("JWT_SECRET"), task.payload.credential),
          ) as Error;
          await this.store.transaction(async (tx) => {
            const current = await tx.lock("tasks", id);
            if (current?.executionToken !== token) return;
            const canceled =
              current.status === "canceled" ||
              (error instanceof ApiError && [404, 409].includes(error.getStatus()));
            metrics.elapsedMs = Date.now() - Date.parse(metrics.startedAt);
            await tx.save("tasks", {
              id,
              status: canceled ? "canceled" : "failed",
              stage: canceled ? "canceled" : "failed",
              executionToken: null,
              retryable: canceled ? 0 : 1,
              error: safe?.message || "生成失败，请重试",
              updatedAt: now(),
              payload: {
                ...current.payload,
                leaseUntil: null,
                mindmapProgress: { ...metrics },
                ...(canceled ? { credential: null, modelSnapshot: null } : {}),
              },
            });
          });
        } finally {
          clearInterval(cancellation);
          clearInterval(heartbeat);
          await checking;
        }
        return "done";
      },
    );
  }
}
