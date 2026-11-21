import { QuizzesModule } from "../quizzes/quizzes.module";
import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module";
import { TasksModule } from "./tasks.module";
import { TaskQueueRuntime } from "./task-queue.runtime";
import { QaTasksModule } from "./qa-tasks.module";
import { MindMapsModule } from "../mindmaps/mindmaps.module";

@Module({
  imports: [DocumentsModule, TasksModule, QaTasksModule, MindMapsModule, QuizzesModule],
  providers: [TaskQueueRuntime],
})
export class PipelineModule {}
