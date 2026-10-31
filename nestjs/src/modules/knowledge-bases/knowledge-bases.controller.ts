import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { KnowledgeBasesService } from './knowledge-bases.service';
import { DocumentsService } from '../documents/documents.service';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';
import { DocumentQueryDto, KnowledgeBaseDto, NameDto } from './dto/knowledge-base.dto';

@Controller('api/knowledge-bases')
export class KnowledgeBasesController {
  constructor(
    private readonly libraries: KnowledgeBasesService,
    private readonly documents: DocumentsService,
  ) {}
  @Get() list(@UserId() user: number) {
    return this.libraries.list(user);
  }
  @Post() create(@UserId() user: number, @Body() body: KnowledgeBaseDto) {
    return this.libraries.create(user, body.name, body.description);
  }
  @Put(':id') update(
    @Param('id', IdPipe) id: number,
    @UserId() user: number,
    @Body() body: KnowledgeBaseDto,
  ) {
    return this.libraries.update(id, user, body.name, body.description);
  }
  @Delete(':id') @HttpCode(202) delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.deleteLibrary(id, user);
  }
  @Get(':id/documents') documentsPage(
    @Param('id', IdPipe) id: number,
    @UserId() user: number,
    @Query() query: DocumentQueryDto,
  ) {
    return this.documents.page(id, user, query);
  }
  @Post(':id/reindex') @HttpCode(202) reindex(
    @Param('id', IdPipe) id: number,
    @UserId() user: number,
  ) {
    return this.documents.reindexLibrary(id, user);
  }
  @Get(':id/categories') categories(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.libraries.categories(id, user);
  }
  @Post(':id/categories') createCategory(
    @Param('id', IdPipe) id: number,
    @UserId() user: number,
    @Body() body: NameDto,
  ) {
    return this.libraries.createCategory(id, user, body.name);
  }
  @Put(':id/categories/:categoryId') updateCategory(
    @Param('id', IdPipe) id: number,
    @Param('categoryId', IdPipe) categoryId: number,
    @UserId() user: number,
    @Body() body: NameDto,
  ) {
    return this.libraries.updateCategory(id, categoryId, user, body.name);
  }
  @Delete(':id/categories/:categoryId') deleteCategory(
    @Param('id', IdPipe) id: number,
    @Param('categoryId', IdPipe) categoryId: number,
    @UserId() user: number,
  ) {
    return this.libraries.deleteCategory(id, categoryId, user);
  }
}
