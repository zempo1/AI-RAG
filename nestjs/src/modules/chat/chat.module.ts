import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { LlmModule } from '../llm/llm.module';
import { HistoryModule } from '../history/history.module';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { QaTasksModule } from '../tasks/qa-tasks.module';

@Module({
  imports: [RagModule, LlmModule, HistoryModule, QaTasksModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
