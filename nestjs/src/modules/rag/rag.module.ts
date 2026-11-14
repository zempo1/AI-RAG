import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RagService } from './rag.service';
import { RetrievalService } from './retrieval.service';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { LlmModule } from '../llm/llm.module';
import { QualityModelsService } from './quality-models.service';
import { SummaryService } from './summary.service';
import { RetrievalRunsController } from './retrieval-runs.controller';
import { PdfTableBackfillService } from './pdf-table-backfill.service';
import { DocumentOriginalsService } from '../documents/document-originals.service';

@Module({
  imports: [EmbeddingsModule, VectorStoreModule, KnowledgeBasesModule, LlmModule],
  controllers: [RetrievalRunsController],
  providers: [RagService, RetrievalService, QualityModelsService, SummaryService, PdfTableBackfillService, DocumentOriginalsService],
  exports: [RagService, RetrievalService, SummaryService],
})
export class RagModule {}
