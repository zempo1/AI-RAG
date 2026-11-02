import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';
import { ChunkUploadService } from './chunk-upload.service';
import { ChunkDto, MergeDto, UploadCheckDto, UploadOptionsDto } from './dto/upload.dto';
import { DocumentUpdateDto } from '../knowledge-bases/dto/knowledge-base.dto';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';
import { ApiError } from '../../common/api-error';
import type { Response } from 'express';
import { PageAssetsService } from './page-assets.service';

const upload = FileInterceptor('file', {
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 12 },
});

@Controller('api')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly chunks: ChunkUploadService,
    private readonly assets: PageAssetsService,
  ) {}

  @Post('upload')
  @HttpCode(202)
  @UseInterceptors(upload)
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @UserId() user: number,
    @Body() options: UploadOptionsDto,
  ) {
    if (!file) throw new ApiError(400, 'file is required');
    let filename = file.originalname;
    // Busboy decodes unextended Content-Disposition filenames as Latin-1,
    // while browsers send UTF-8. Keep already-decoded Unicode untouched.
    if ([...filename].every((character) => character.charCodeAt(0) <= 255)) {
      try {
        filename = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(filename, 'latin1'),
        );
      } catch {
        /* A genuine legacy Latin-1 filename is already readable. */
      }
    }
    return this.documents.ingest(file.buffer, filename, user, {
      ...options,
      idempotencyKey: options.idempotencyKey || options.uploadId,
    });
  }

  @Get('documents')
  list(@UserId() user: number) {
    return this.documents.list(user);
  }

  @Get('documents/:id/versions/:versionId/pages/:page/image')
  async pageImage(
    @Param('id', IdPipe) id: number,
    @Param('versionId', IdPipe) versionId: number,
    @Param('page', IdPipe) page: number,
    @Query('profile') profile: string,
    @UserId() user: number,
    @Res() response: Response,
  ) {
    const bytes = await this.assets.image(user, id, { versionId, page, profile });
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }

  // 区域接口同样经文档、版本、知识库归属校验，路径不接受自由文件名。
  @Get('documents/:id/versions/:versionId/pages/:page/regions/:regionId/image')
  async regionImage(
    @Param('id', IdPipe) id: number,
    @Param('versionId', IdPipe) versionId: number,
    @Param('page', IdPipe) page: number,
    @Param('regionId') regionId: string,
    @Query('profile') profile: string,
    @UserId() user: number,
    @Res() response: Response,
  ) {
    const bytes = await this.assets.regionImage(user, id, { versionId, page, profile, regionId });
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }

  @Get('documents/:id')
  async summary(@Param('id', IdPipe) id: number, @UserId() user: number) {
    const { content, userId, ...doc } = await this.documents.owned(id, user);
    return doc;
  }

  @Post('documents/:id/activate')
  activate(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.activate(id, user);
  }

  @Delete('documents/:id')
  @HttpCode(202)
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.delete(id, user);
  }

  @Put('documents/:id')
  update(@Param('id', IdPipe) id: number, @UserId() user: number, @Body() body: DocumentUpdateDto) {
    return this.documents.update(id, user, body);
  }

  @Put('documents/:id/file')
  @HttpCode(202)
  @UseInterceptors(upload)
  replace(
    @Param('id', IdPipe) id: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @UserId() user: number,
    @Body() options: UploadOptionsDto,
  ) {
    return this.upload(file, user, { ...options, documentId: id });
  }

  @Post('documents/:id/reindex')
  @HttpCode(202)
  reindex(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.reindex(id, user);
  }

  @Get('upload/check')
  check(@Query() dto: UploadCheckDto, @UserId() user: number) {
    return this.chunks.check(dto, user);
  }

  @Post('upload/chunk')
  @UseInterceptors(upload)
  chunk(
    @Body() dto: ChunkDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @UserId() user: number,
  ) {
    return this.chunks.upload(dto, file, user);
  }

  @Post('upload/merge')
  @HttpCode(202)
  merge(@Body() dto: MergeDto, @UserId() user: number) {
    return this.chunks.merge(dto, user);
  }
}
