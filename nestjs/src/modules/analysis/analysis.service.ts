/** 实现业务处理；所属能力：生成并管理文档摘要、大纲和学习卡片等分析结果。 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentsService } from "../documents/documents.service";
import { LlmService } from "../llm/llm.service";
import { Store, Row, publicRow } from "../../persistence/store";
import { analysisPrompt } from "./prompts";
import { ApiError } from "../../common/api-error";
import { TokenizerService } from "../embeddings/tokenizer.service";
import { generateFlashcards } from "./flashcard-generation";

@Injectable()
export class AnalysisService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
    private readonly store: Store,
    private readonly config: ConfigService = new ConfigService(),
    private readonly tokenizer: TokenizerService = new TokenizerService(config),
  ) {}

  async generate(documentId: number, type: string, userId: number, apiKey?: string) {
    const doc = await this.documents.ready(documentId, userId);
    const flashcard = type === "FLASHCARD";
    const result = flashcard
      ? await this.generateCards(doc, apiKey)
      : (await this.llm.complete(analysisPrompt(type, doc.content.slice(0, 20000)), apiKey)).trim();
    if (!result) throw new ApiError(500, "模型返回空内容");
    return publicRow(
      await this.store.transaction(async (tx) => {
        const kb = await tx.lock("knowledgeBases", doc.knowledgeBaseId);
        // 模型生成期间文档可能被删除，落库前需重新确认来源仍存在且属于当前用户。
        const source = await tx.lock("documents", documentId);
        if (
          !kb ||
          kb.deletedAt ||
          kb.userId !== userId ||
          !source ||
          source.userId !== userId ||
          source.deletedAt ||
          source.knowledgeBaseId !== kb.id
        )
          throw new ApiError(500, "Document not found: " + documentId);
        if (flashcard) this.verifyCardSource(doc, source);
        return tx.save("analyses", {
          userId,
          documentId,
          versionId: doc.activeVersionId,
          documentName: doc.filename,
          type,
          content: result,
        });
      }),
    );
  }

  private verifyCardSource(doc: Row, source: Row | undefined) {
    if (
      !source ||
      source.deletedAt ||
      source.userId !== doc.userId ||
      source.knowledgeBaseId !== doc.knowledgeBaseId ||
      source.activeVersionId !== doc.activeVersionId ||
      source.activeIndexRevisionId !== doc.activeIndexRevisionId
    )
      throw new ApiError(409, "学习卡片来源版本或索引已更新，请重新生成");
    if (
      !source.activeIndexRevisionId ||
      source.status !== "ready" ||
      (source.desiredIndexRevisionId != null &&
        source.desiredIndexRevisionId !== source.activeIndexRevisionId)
    )
      throw new ApiError(409, "文档尚未就绪，请等待索引完成");
  }

  private async generateCards(doc: Row, apiKey?: string) {
    this.verifyCardSource(doc, doc);
    const revision = await this.store.get("indexRevisions", doc.activeIndexRevisionId);
    if (!revision || revision.documentId !== doc.id || revision.versionId !== doc.activeVersionId)
      throw new ApiError(409, "学习卡片来源索引不可用");
    const chunks = (await this.store.list("chunks", { indexRevisionId: revision.id })).filter(
      (chunk) => chunk.documentId === doc.id && chunk.versionId === doc.activeVersionId,
    );
    return generateFlashcards(
      chunks,
      this.llm,
      this.config,
      this.tokenizer,
      async () => {
        this.verifyCardSource(doc, await this.store.get("documents", doc.id));
      },
      apiKey,
    );
  }

  async list(type: string, userId: number, knowledgeBaseId?: number) {
    let allowed: Set<number> | undefined;
    if (knowledgeBaseId !== undefined) {
      const kb = await this.store.get("knowledgeBases", knowledgeBaseId);
      if (!kb || kb.userId !== userId || kb.deletedAt) throw new ApiError(404, "知识库不存在");
      allowed = new Set(
        (await this.store.list("documents", { userId, knowledgeBaseId }))
          .filter((doc) => !doc.deletedAt)
          .map((doc) => doc.id),
      );
    }
    const sources = new Map<number, Promise<Row | undefined>>();
    return Promise.all(
      (await this.store.list("analyses", { type, userId }))
        .filter((row) => !allowed || allowed.has(row.documentId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
        .map(async (row) => {
          if (row.documentId && !sources.has(row.documentId))
            sources.set(row.documentId, this.store.get("documents", row.documentId));
          const source = row.documentId ? await sources.get(row.documentId) : null;
          return {
            ...publicRow(row),
            sourceOutdated: !!source && row.versionId !== source.activeVersionId,
          };
        }),
    );
  }

  async delete(id: number, userId: number): Promise<void> {
    const row = await this.store.get("analyses", id);
    if (!row || row.userId !== userId) throw new ApiError(500, "Analysis not found: " + id);
    await this.store.delete("analyses", id);
  }
}
