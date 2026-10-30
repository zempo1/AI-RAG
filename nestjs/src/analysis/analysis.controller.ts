import { Body, Controller, Delete, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AnalysisService } from './analysis.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../common/pipes/id.pipe';

class AnalysisType {
  @IsIn(['SUMMARY', 'OUTLINE', 'FLASHCARD'])
  type: string;
}

class GenerateAnalysis extends AnalysisType {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentId: number;
}

@Controller('api/analysis')
export class AnalysisController {
  constructor(private readonly service: AnalysisService) {}

  @Post('generate')
  generate(
    @Body() dto: GenerateAnalysis,
    @UserId() user: number,
    @Headers('x-api-key') key?: string,
  ) {
    return this.service.generate(dto.documentId, dto.type, user, key);
  }

  @Get()
  list(@Query() dto: AnalysisType, @UserId() user: number) {
    return this.service.list(dto.type, user);
  }

  @Delete(':id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.service.delete(id, user);
  }
}
