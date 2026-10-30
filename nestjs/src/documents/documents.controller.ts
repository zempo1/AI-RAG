import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';
import { ChunkUploadService } from './chunk-upload.service';
import { ChunkDto, MergeDto, UploadCheckDto } from './upload.dto';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../common/pipes/id.pipe';
import { ApiError } from '../common/api-error';

const upload = FileInterceptor('file', {
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
});

@Controller('api')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly chunks: ChunkUploadService,
  ) {}

  @Post('upload')
  @UseInterceptors(upload)
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @UserId() user: number) {
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
    await this.documents.ingest(file.buffer, filename, user);
    return 'File uploaded and ingested successfully.';
  }

  @Get('documents')
  list(@UserId() user: number) {
    return this.documents.list(user);
  }

  @Post('documents/:id/activate')
  activate(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.activate(id, user);
  }

  @Delete('documents/:id')
  delete(@Param('id', IdPipe) id: number, @UserId() user: number) {
    return this.documents.delete(id, user);
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
  merge(@Body() dto: MergeDto, @UserId() user: number) {
    return this.chunks.merge(dto, user);
  }
}
