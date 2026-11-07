import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { QaTasksService } from './qa-tasks.service';
import { AgentModule } from '../agent/agent.module';
import { HistoryModule } from '../history/history.module';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { AgentQaTasksService } from './agent-qa.service';
@Module({ imports: [RagModule, AgentModule, HistoryModule, KnowledgeBasesModule],
  providers: [QaTasksService, AgentQaTasksService], exports: [QaTasksService, AgentQaTasksService] })
export class QaTasksModule {}
