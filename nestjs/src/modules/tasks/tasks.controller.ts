import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { TasksService } from './tasks.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';

class TasksQuery {
  @Type(() => Number) @IsInt() @Min(1) knowledgeBaseId: number;
}
@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}
  @Delete() clear(@UserId() user: number, @Query() query: TasksQuery) {
    return this.tasks.clearCompleted(user, query.knowledgeBaseId);
  }
  @Delete(':id') dismiss(@UserId() user: number, @Param('id', IdPipe) id: number) {
    return this.tasks.dismiss(id, user);
  }
  @Get() list(@UserId() user: number, @Query() query: TasksQuery) {
    return this.tasks.list(user, query.knowledgeBaseId);
  }
  @Get(':id') get(@UserId() user: number, @Param('id', IdPipe) id: number) {
    return this.tasks.get(id, user);
  }
  @Post(':id/retry') retry(@UserId() user: number, @Param('id', IdPipe) id: number) {
    return this.tasks.retry(id, user);
  }
}
