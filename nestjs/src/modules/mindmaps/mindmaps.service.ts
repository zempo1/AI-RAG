import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { DocumentsService } from "../documents/documents.service";
import { LlmService } from "../llm/llm.service";
import { Store, Row, publicRow, now } from "../../persistence/store";
import { ApiError } from "../../common/api-error";
import { TokenizerService } from "../embeddings/tokenizer.service";
import { TasksService, terminalTask } from "../tasks/tasks.service";
import { sealRuntimeModels } from "../model-settings/model-runtime";
import { sealQaCredential } from "../tasks/qa-credentials";
import { normalizeMindMap } from "./mindmap-data";

import { MindMapRunner } from "./mindmap-runner";

@Injectable()
export class MindMapsService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
    private readonly store: Store,
    @Optional() private readonly config: ConfigService = new ConfigService(),
    @Optional() private readonly tokenizer: TokenizerService = new TokenizerService(config),
    @Optional() private readonly tasks?: TasksService,
  ) {}

  async generate(
    userId: number,
    documentId?: number | null,
    apiKey?: string,
    requestId: string = randomUUID(),
  ) {
    if (!documentId) throw new ApiError(400, "请选择文档");
    const doc = await this.documents.ready(documentId, userId);
    if (!doc.activeIndexRevisionId) throw new ApiError(409, "文档索引不可用，请先重建索引");
    const key = `mindmap/${userId}/${requestId}`;
    const row = await this.store.transaction(async (tx) => {
      const kb = await tx.lock("knowledgeBases", doc.knowledgeBaseId);
      const source = await tx.lock("documents", doc.id);
      if (!kb || kb.deletedAt || !source || source.deletedAt || source.userId !== userId)
        throw new ApiError(404, "来源已失效");
      const all = await tx.list("tasks", { userId, kind: "mindmap" });
      const previous = all.find(
        (t) => t.idempotencyKey === key || t.payload?.requestIds?.includes(requestId),
      );
      if (previous) {
        if (
          previous.documentId !== doc.id ||
          previous.indexRevisionId !== doc.activeIndexRevisionId
        )
          throw new ApiError(409, "requestId 已用于不同来源");
        return previous;
      }
      if (
        source.activeVersionId !== doc.activeVersionId ||
        source.activeIndexRevisionId !== doc.activeIndexRevisionId
      )
        throw new ApiError(409, "文档已更新，请重新生成");
      const active = all.find(
        (t) =>
          t.documentId === doc.id &&
          t.indexRevisionId === doc.activeIndexRevisionId &&
          !terminalTask(t.status),
      );
      if (active)
        return tx.save("tasks", {
          id: active.id,
          payload: {
            ...active.payload,
            requestIds: [...new Set([...(active.payload?.requestIds || []), requestId])],
          },
        });
      return tx.save("tasks", {
        userId,
        knowledgeBaseId: doc.knowledgeBaseId,
        documentId: doc.id,
        indexRevisionId: doc.activeIndexRevisionId,
        parentTaskId: null,
        idempotencyKey: key,
        kind: "mindmap",
        status: "queued",
        stage: "queued",
        completed: 0,
        total: null,
        attempts: 0,
        dispatchGeneration: 0,
        retryable: 1,
        error: null,
        executionToken: null,
        updatedAt: now(),
        payload: {
          versionId: doc.activeVersionId,
          filename: doc.filename,
          requestId,
          modelSnapshot: sealRuntimeModels(this.config),
          credential: sealQaCredential(this.config.getOrThrow("JWT_SECRET"), apiKey),
        },
      });
    });
    return { taskId: row.id as number, status: row.status as string };
  }

  async process(id: number, attempt = 1, report?: (value: object) => Promise<void>) {
    return new MindMapRunner(this.store, this.llm, this.config, this.tokenizer).process(
      id,
      attempt,
      report,
    );
  }

  async owned(id: number, userId: number) {
    const row = await this.store.get("mindmaps", id);
    if (!row || row.userId !== userId) throw new ApiError(404, "思维导图不存在");
    return row;
  }
  private outdated(row: Row, doc?: Row | null) {
    let revision: number | undefined;
    try {
      revision = JSON.parse(row.data || "{}").meta?.source?.indexRevisionId;
    } catch {
      /* historical invalid data is reported by editor */
    }
    return (
      !!doc &&
      (row.versionId !== doc.activeVersionId ||
        (revision !== undefined && revision !== doc.activeIndexRevisionId))
    );
  }
  async get(id: number, userId: number) {
    const row = await this.owned(id, userId);
    const doc = row.documentId ? await this.store.get("documents", row.documentId) : null;
    let data = row.data;
    try {
      data = JSON.stringify(normalizeMindMap(data, { nodes: 100000, depth: 100 }));
    } catch {
      /* Let the reader explain corrupted historical data. */
    }
    return { ...publicRow(row), data, sourceOutdated: this.outdated(row, doc) };
  }
  async list(userId: number) {
    const sources = new Map<number, Promise<Row | undefined>>();
    return Promise.all(
      (await this.store.list("mindmaps", { userId }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id - a.id)
        .map(async (row) => {
          if (row.documentId && !sources.has(row.documentId))
            sources.set(row.documentId, this.store.get("documents", row.documentId));
          const source = row.documentId ? await sources.get(row.documentId) : null;
          return { ...publicRow(row), sourceOutdated: this.outdated(row, source) };
        }),
    );
  }
  async workspace(userId: number, knowledgeBaseId: number) {
    const kb = await this.store.get("knowledgeBases", knowledgeBaseId);
    if (!kb || kb.deletedAt || kb.userId !== userId) throw new ApiError(404, "知识库不存在");
    const ids = new Set(
      (await this.store.list("documents", { userId, knowledgeBaseId }))
        .filter((d) => !d.deletedAt)
        .map((d) => d.id),
    );
    const items = (await this.list(userId))
      .filter((m: any) => ids.has(m.documentId))
      .map(({ data, ...row }: Record<string, any>) => row);
    const generationTasks = this.tasks
      ? (await this.tasks.list(userId, knowledgeBaseId)).filter((t) => t.kind === "mindmap")
      : [];
    return { items, generationTasks };
  }
  async update(id: number, userId: number, input: string) {
    const row = await this.owned(id, userId);
    if (Buffer.byteLength(input, "utf8") > 2 * 1024 * 1024)
      throw new ApiError(413, "思维导图数据超过2MiB");
    const data = normalizeMindMap(input);
    return this.store.transaction(async (tx) => {
      if (row.documentId) {
        const source = await tx.get("documents", row.documentId);
        if (!source) throw new ApiError(404, "来源不存在");
        const kb = await tx.lock("knowledgeBases", source.knowledgeBaseId);
        const doc = await tx.lock("documents", source.id);
        if (!kb || kb.deletedAt || !doc || doc.deletedAt || doc.userId !== userId)
          throw new ApiError(404, "来源已删除");
      }
      const current = await tx.lock("mindmaps", id);
      if (!current || current.userId !== userId) throw new ApiError(404, "思维导图不存在");
      let previous: any;
      try {
        previous = JSON.parse(current.data || "{}");
      } catch {
        previous = {};
      }
      data.meta = previous.meta || {};
      return publicRow(await tx.save("mindmaps", { ...current, data: JSON.stringify(data) }));
    });
  }
  async delete(id: number, userId: number): Promise<void> {
    await this.owned(id, userId);
    await this.store.delete("mindmaps", id);
  }
}
