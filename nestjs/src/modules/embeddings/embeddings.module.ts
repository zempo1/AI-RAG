import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { TokenizerService } from './tokenizer.service';

@Module({
  providers: [EmbeddingsService, TokenizerService],
  exports: [EmbeddingsService, TokenizerService],
})
export class EmbeddingsModule {}
