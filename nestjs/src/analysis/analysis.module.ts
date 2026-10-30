import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { LlmModule } from '../llm/llm.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [DocumentsModule, LlmModule],
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}
