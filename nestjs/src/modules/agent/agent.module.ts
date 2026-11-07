import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { LlmModule } from '../llm/llm.module';
import { AgentService } from './agent.service';
@Module({ imports: [RagModule, LlmModule], providers: [AgentService], exports: [AgentService] })
export class AgentModule {}
