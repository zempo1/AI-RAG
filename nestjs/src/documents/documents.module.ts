import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentParser } from './parsers/document.parser';
import { RecursiveChunker } from './chunkers/recursive.chunker';
import { ChunkUploadService } from './chunk-upload.service';

@Module({
  imports: [EmbeddingsModule, VectorStoreModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentParser, RecursiveChunker, ChunkUploadService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
