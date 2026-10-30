import { Module } from '@nestjs/common';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RagService } from './rag.service';

@Module({
  imports: [EmbeddingsModule, VectorStoreModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
