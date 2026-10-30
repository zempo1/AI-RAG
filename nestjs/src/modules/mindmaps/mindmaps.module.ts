import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { LlmModule } from '../llm/llm.module';
import { MindMapsService } from './mindmaps.service';
import { MindMapsController } from './mindmaps.controller';

@Module({
  imports: [DocumentsModule, LlmModule],
  controllers: [MindMapsController],
  providers: [MindMapsService],
})
export class MindMapsModule {}
