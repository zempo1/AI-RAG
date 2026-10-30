import { AnalysisTypeDto } from './dto/analysis-type.dto';
import { GenerateAnalysisDto } from './dto/generate-analysis.dto';
import { Body, Controller, Delete, Get, Headers, Param, Post, Query } from '@nestjs/common';

import { AnalysisService } from './analysis.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';

@Controller('api/analysis')
export class AnalysisController {
  constructor(private readonly service: AnalysisService) {}

  @Post('generate')
  generate(
    @Body() dto: GenerateAnalysisDto,
    @UserId() user: number,
    @Headers('x-api-key') key?: string,
  ) {
    return this.service.generate(dto.documentId, dto.type, user, key);
  }

  @Get()
  list(@Query() dto: AnalysisTypeDto, @UserId() user: number) {
    return this.service.list(dto.type, user);
  }

  @Delete(':id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.service.delete(id, user);
  }
}
