import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentParser } from './parsers/document.parser';
import { RecursiveChunker } from './chunkers/recursive.chunker';
import { ChunkUploadService } from './chunk-upload.service';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { TasksModule } from '../tasks/tasks.module';
import { IndexingService } from './indexing.service';
import { KnowledgeBasesController } from '../knowledge-bases/knowledge-bases.controller';
import { LlmModule } from '../llm/llm.module';
import { PageAssetsService } from './page-assets.service';
import { PdfVisualService } from './parsers/pdf-visual.service';

@Module({
  imports: [EmbeddingsModule, VectorStoreModule, KnowledgeBasesModule, TasksModule, LlmModule],
  controllers: [DocumentsController, KnowledgeBasesController],
  providers: [
    DocumentsService,
    DocumentParser,
    RecursiveChunker,
    ChunkUploadService,
    IndexingService,
    PageAssetsService,
    PdfVisualService,
  ],
  exports: [DocumentsService, IndexingService, PageAssetsService],
})
export class DocumentsModule {}
