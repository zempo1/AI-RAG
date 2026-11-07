import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { KnowledgeBasesModule } from '../knowledge-bases/knowledge-bases.module';
import { TasksController } from './tasks.controller';
import { QaTasksModule } from './qa-tasks.module';

@Module({
  imports: [KnowledgeBasesModule, QaTasksModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
