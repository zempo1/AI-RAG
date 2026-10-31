import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { TasksModule } from './tasks.module';
import { TaskQueueRuntime } from './task-queue.runtime';

@Module({ imports: [DocumentsModule, TasksModule], providers: [TaskQueueRuntime] })
export class PipelineModule {}
