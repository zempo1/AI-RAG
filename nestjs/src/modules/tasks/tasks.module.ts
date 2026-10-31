import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { TasksController } from './tasks.controller';

@Module({
  imports: [KnowledgeBasesModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
