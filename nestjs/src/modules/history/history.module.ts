import { Module } from '@nestjs/common';
import { HistoryService } from './history.service';
import { HistoryController } from './history.controller';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';

@Module({
  imports: [KnowledgeBasesModule],
  controllers: [HistoryController],
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
