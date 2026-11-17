import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module";
import { LlmModule } from "../llm/llm.module";
import { MindMapsService } from "./mindmaps.service";
import { MindMapsController } from "./mindmaps.controller";
import { EmbeddingsModule } from "../embeddings/embeddings.module";
import { TasksModule } from "../tasks/tasks.module";

@Module({
  imports: [DocumentsModule, LlmModule, EmbeddingsModule, TasksModule],
  controllers: [MindMapsController],
  providers: [MindMapsService],
  exports: [MindMapsService],
})
export class MindMapsModule {}
