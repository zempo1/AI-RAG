import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Headers,
  HttpCode,
} from "@nestjs/common";
import {
  IsInt,
  Min,
  Max,
  IsUUID,
  IsOptional,
  IsString,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsBoolean,
} from "class-validator";
import { Type } from "class-transformer";
import { UserId } from "../auth/auth.guard";
import { IdPipe } from "../../common/pipes/id.pipe";
import { QuizzesService } from "./quizzes.service";
class GenerateQuizDto {
  @IsInt() @Min(1) documentId: number;
  @IsInt() @Min(0) @Max(20) singleCount: number;
  @IsInt() @Min(0) @Max(20) multipleCount: number;
  @IsUUID() requestId: string;
}
class StartQuizAttemptDto {
  @IsUUID() requestId: string;
}
class QuizProgressDto {
  @IsOptional() @IsInt() @Min(0) @Max(19) currentIndex?: number;
  @IsOptional() @IsString() @MaxLength(10) questionId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(["A", "B", "C", "D"], { each: true })
  selectedOptionIds?: string[];
  @IsOptional() @IsBoolean() submit?: boolean;
}
@Controller("api/quizzes")
export class QuizzesController {
  constructor(private readonly service: QuizzesService) {}
  @Post("generate") @HttpCode(202) generate(
    @Body() dto: GenerateQuizDto,
    @UserId() user: number,
    @Headers("x-api-key") key?: string,
  ) {
    return this.service.generate(
      user,
      dto.documentId,
      dto.singleCount,
      dto.multipleCount,
      key,
      dto.requestId,
    );
  }
  @Get("workspace") workspace(
    @UserId() user: number,
    @Query("knowledgeBaseId", IdPipe) kb: number,
  ) {
    return this.service.workspace(user, kb);
  }
  @Get(":id") get(@Param("id", IdPipe) id: number, @UserId() user: number) {
    return this.service.get(id, user);
  }
  @Delete(":id") delete(@Param("id", IdPipe) id: number, @UserId() user: number) {
    return this.service.delete(id, user);
  }
  @Post(":id/attempts") attempt(
    @Param("id", IdPipe) id: number,
    @UserId() user: number,
    @Body() dto: StartQuizAttemptDto,
  ) {
    return this.service.startAttempt(id, user, dto.requestId);
  }
}
@Controller("api/quiz-attempts")
export class QuizAttemptsController {
  constructor(private readonly service: QuizzesService) {}
  @Get(":id") get(@Param("id", IdPipe) id: number, @UserId() user: number) {
    return this.service.getAttempt(id, user);
  }
  @Patch(":id/progress") progress(
    @Param("id", IdPipe) id: number,
    @UserId() user: number,
    @Body() dto: QuizProgressDto,
  ) {
    return this.service.progress(id, user, dto);
  }
}
