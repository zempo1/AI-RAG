import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { QaTasksService } from './qa-tasks.service';
@Module({ imports: [RagModule], providers: [QaTasksService], exports: [QaTasksService] })
export class QaTasksModule {}
