import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsUUID,
  ValidateNested,
  Matches,
} from "class-validator";
import { Type } from "class-transformer";

export class QuizContextDto {
  @IsInt() @Min(1) attemptId: number;
  @IsString() @Matches(/^q(?:[1-9]|1[0-9]|20)$/) questionId: string;
}

export class ChatDto {
  @IsOptional() @ValidateNested() @Type(() => QuizContextDto) quizContext?: QuizContextDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) chatId?: number | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  documentIds?: number[];
  @IsOptional() @IsIn(["auto", "general", "search", "overview", "compare"]) mode?:
    "auto" | "general" | "search" | "overview" | "compare";
  @IsOptional() @IsUUID() requestId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) knowledgeBaseId?: number;
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  question?: string;
}
