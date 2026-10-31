import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RagService } from './rag.service';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';

@Module({
  imports: [EmbeddingsModule, VectorStoreModule, KnowledgeBasesModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
