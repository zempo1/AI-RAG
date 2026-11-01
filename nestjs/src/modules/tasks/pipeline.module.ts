import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { TasksModule } from './tasks.module';
import { TaskQueueRuntime } from './task-queue.runtime';
import { QaTasksModule } from './qa-tasks.module';

@Module({ imports: [DocumentsModule, TasksModule, QaTasksModule], providers: [TaskQueueRuntime] })
export class PipelineModule {}
