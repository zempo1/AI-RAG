import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
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
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { byteRange, DocumentOriginalsService } from './document-originals.service';
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
    private readonly originals: DocumentOriginalsService,
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

  @Get('documents/:id/preview')
  @Header('Cache-Control', 'private, no-store')
  preview(
    @Param('id', IdPipe) id: number,
    @UserId() user: number,
    @Query('versionId') versionId?: string,
  ) {
    const version = versionId === undefined ? undefined : Number(versionId);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
      throw new ApiError(400, '文档版本无效');
    return this.originals.preview(user, id, version);
  }

  // Express also routes HEAD through GET; the handler omits the body explicitly.
  @Get('documents/:id/versions/:versionId/original')
  async original(
    @Param('id', IdPipe) id: number,
    @Param('versionId', IdPipe) versionId: number,
    @UserId() user: number,
    @Headers('range') range: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const file = await this.originals.file(user, id, versionId);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
    let selected: ReturnType<typeof byteRange>;
    try {
      selected = byteRange(request.method === 'HEAD' ? undefined : range, file.size);
    } catch {
      response.setHeader('Content-Range', `bytes */${file.size}`);
      response.status(416).end();
      return;
    }
    response.status(selected ? 206 : 200);
    response.setHeader('Content-Length', selected ? selected.end - selected.start + 1 : file.size);
    if (selected)
      response.setHeader('Content-Range', `bytes ${selected.start}-${selected.end}/${file.size}`);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    try {
      await pipeline(createReadStream(file.path, selected || undefined), response);
    } catch (error) {
      if (!response.destroyed) throw error;
    }
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

  @Get('documents/:id/versions/:versionId/citation-context')
  @Header('Cache-Control', 'private, no-store')
  citationContext(
    @Param('id', IdPipe) id: number,
    @Param('versionId', IdPipe) versionId: number,
    @Query('revisionId', IdPipe) revisionId: number,
    @Query('start', ParseIntPipe) start: number,
    @Query('end', ParseIntPipe) end: number,
    @UserId() user: number,
  ) {
    return this.documents.citationContext(id, user, versionId, revisionId, start, end);
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
