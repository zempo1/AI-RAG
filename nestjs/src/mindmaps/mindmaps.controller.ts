import { Body, Controller, Delete, Get, Headers, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MindMapsService } from './mindmaps.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../common/pipes/id.pipe';

class GenerateMap {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  documentId?: number | null;
}

class UpdateMap {
  @IsString({ message: 'data 字段必须是 JSON 字符串' })
  data: string;
}

@Controller('api/mindmaps')
export class MindMapsController {
  constructor(private readonly service: MindMapsService) {}

  @Post('generate')
  generate(@Body() dto: GenerateMap, @UserId() user: number, @Headers('x-api-key') key?: string) {
    return this.service.generate(user, dto?.documentId, key);
  }

  @Get()
  list(@UserId() user: number) {
    return this.service.list(user);
  }

  @Get(':id')
  get(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.service.get(id, user);
  }

  @Put(':id')
  update(@Param('id', IdPipe) id: number, @Body() dto: UpdateMap, @UserId() user: number) {
    return this.service.update(id, user, dto.data);
  }

  @Delete(':id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.service.delete(id, user);
  }
}
