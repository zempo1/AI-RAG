import { GenerateMindMapDto } from './dto/generate-mindmap.dto';
import { UpdateMindMapDto } from './dto/update-mindmap.dto';
import { Body, Controller, Delete, Get, Headers, Param, Post, Put } from '@nestjs/common';

import { MindMapsService } from './mindmaps.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';

@Controller('api/mindmaps')
export class MindMapsController {
  constructor(private readonly service: MindMapsService) {}

  @Post('generate')
  generate(
    @Body() dto: GenerateMindMapDto,
    @UserId() user: number,
    @Headers('x-api-key') key?: string,
  ) {
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
  update(@Param('id', IdPipe) id: number, @Body() dto: UpdateMindMapDto, @UserId() user: number) {
    return this.service.update(id, user, dto.data);
  }

  @Delete(':id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.service.delete(id, user);
  }
}
