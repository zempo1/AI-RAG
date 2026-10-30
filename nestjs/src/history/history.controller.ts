import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { HistoryService } from './history.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../common/pipes/id.pipe';

class CreateChat {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

@Controller('api/chats')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(@UserId() user: number) {
    return this.history.list(user);
  }

  @Get(':id')
  get(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.history.get(id, user);
  }

  @Post()
  create(@Body() body: CreateChat, @UserId() user: number) {
    return this.history.create(body.title ?? 'New Chat', user);
  }

  @Delete(':id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.history.delete(id, user);
  }
}
