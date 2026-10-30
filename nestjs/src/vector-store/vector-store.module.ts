import { Module } from '@nestjs/common';
import { VectorStore } from './vector-store.interface';
import { InMemoryVectorStore } from './in-memory-vector-store.service';

@Module({
  providers: [{ provide: VectorStore, useClass: InMemoryVectorStore }],
  exports: [VectorStore],
})
export class VectorStoreModule {}
