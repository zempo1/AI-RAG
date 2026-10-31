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

@Module({
  imports: [EmbeddingsModule, VectorStoreModule, KnowledgeBasesModule, TasksModule],
  controllers: [DocumentsController, KnowledgeBasesController],
  providers: [
    DocumentsService,
    DocumentParser,
    RecursiveChunker,
    ChunkUploadService,
    IndexingService,
  ],
  exports: [DocumentsService, IndexingService],
})
export class DocumentsModule {}
