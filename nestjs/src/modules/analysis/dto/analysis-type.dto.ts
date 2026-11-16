import { IsIn, IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class AnalysisTypeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  knowledgeBaseId?: number;
  @IsIn(["SUMMARY", "OUTLINE", "FLASHCARD"])
  type: string;
}
