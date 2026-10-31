import { Module } from '@nestjs/common';
import { VectorStore } from './vector-store.interface';
import { InMemoryVectorStore } from './in-memory-vector-store.service';
import { QdrantVectorStore } from './qdrant-vector-store.service';
import { ConfigService } from '@nestjs/config';

@Module({
  providers: [
    {
      provide: VectorStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('VECTOR_DRIVER') === 'memory'
          ? new InMemoryVectorStore()
          : new QdrantVectorStore(config),
    },
  ],
  exports: [VectorStore],
})
export class VectorStoreModule {}
