import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  open,
  unlink,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { DocumentParser } from './parsers/document.parser';
import { DocumentsService } from './documents.service';
import { ChunkDto, MergeDto, UploadCheckDto } from './dto/upload.dto';
import { ApiError } from '../../common/api-error';

@Injectable()
export class ChunkUploadService {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
    private readonly parser: DocumentParser,
  ) {}

  private async scope(user: number, dto: UploadCheckDto) {
    this.parser.validateFilename(dto.filename);
    const knowledgeBaseId = await this.documents.uploadScope(
      user,
      dto.knowledgeBaseId,
      dto.documentId,
    );
    const session = dto.uploadId || dto.md5.toLowerCase();
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          user,
          knowledgeBaseId,
          dto.documentId || 0,
          session,
          dto.filename,
          dto.md5.toLowerCase(),
        ]),
      )
      .digest('hex');
    return {
      knowledgeBaseId,
      key,
      dir: join(this.config.getOrThrow<string>('UPLOAD_TEMP_DIR'), key),
    };
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(key) === pending) this.locks.delete(key);
    }
  }
  async check(dto: UploadCheckDto, user: number) {
    const scope = await this.scope(user, dto);
    return this.locked(scope.key, async () => {
      const completed = await this.documents.submission(
        user,
        scope.knowledgeBaseId,
        dto.documentId,
        scope.key,
      );
      if (completed) return { uploaded: true, ...completed };
      let files: string[];
      try {
        files = await readdir(scope.dir);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        files = [];
      }
      return {
        uploaded: false,
        uploadedChunks: files
          .filter((f) => /^chunk_\d+$/.test(f))
          .map((f) => Number(f.slice(6)))
          .sort((a, b) => a - b),
      };
    });
  }
  async upload(dto: ChunkDto, file: Express.Multer.File | undefined, user: number) {
    const scope = await this.scope(user, dto);
    if (!file?.size) throw new ApiError(400, '分片不能为空');
    if (dto.chunkIndex >= dto.totalChunks) throw new ApiError(400, '分片编号超出范围');
    return this.locked(scope.key, async () => {
      await mkdir(scope.dir, { recursive: true });
      const path = join(scope.dir, 'metadata.json');
      try {
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        if (metadata.totalChunks !== dto.totalChunks) throw new ApiError(400, '分片总数不一致');
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        await writeFile(path, JSON.stringify({ totalChunks: dto.totalChunks }));
      }
      const temporary = join(scope.dir, 'pending_' + randomUUID());
      try {
        await writeFile(temporary, file.buffer, { flag: 'wx' });
        await rename(temporary, join(scope.dir, 'chunk_' + dto.chunkIndex));
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      return { chunkIndex: dto.chunkIndex, received: true };
    });
  }
  async merge(dto: MergeDto, user: number) {
    const scope = await this.scope(user, dto);
    return this.locked(scope.key, async () => {
      const previous = await this.documents.submission(
        user,
        scope.knowledgeBaseId,
        dto.documentId,
        scope.key,
      );
      if (previous) return previous;
      let total = 0;
      for (let i = 0; i < dto.totalChunks; i++) {
        try {
          total += (await stat(join(scope.dir, 'chunk_' + i))).size;
        } catch (error: any) {
          if (error.code === 'ENOENT') throw new ApiError(400, 'Missing chunk: ' + i);
          throw error;
        }
        if (total > this.config.getOrThrow<number>('MAX_DOCUMENT_BYTES'))
          throw new ApiError(413, '文件超过文档解析大小限制');
      }
      if (
        JSON.parse(await readFile(join(scope.dir, 'metadata.json'), 'utf8')).totalChunks !==
        dto.totalChunks
      )
        throw new ApiError(400, '分片总数不一致');
      const merged = join(scope.dir, 'merge_' + randomUUID());
      const output = await open(merged, 'wx');
      const hash = createHash('md5');
      try {
        for (let i = 0; i < dto.totalChunks; i++)
          for await (const buffer of createReadStream(join(scope.dir, 'chunk_' + i))) {
            hash.update(buffer);
            await output.writeFile(buffer);
          }
      } finally {
        await output.close();
      }
      try {
        if (hash.digest('hex') !== dto.md5.toLowerCase())
          throw new ApiError(400, '文件指纹不一致，请重新上传');
        const accepted = await this.documents.ingest(await readFile(merged), dto.filename, user, {
          knowledgeBaseId: scope.knowledgeBaseId,
          categoryId: dto.categoryId,
          documentId: dto.documentId,
          idempotencyKey: scope.key,
        });
        // Scope directory is a SHA-256 child of UPLOAD_TEMP_DIR, never a user path.
        await rm(scope.dir, { recursive: true, force: true }).catch(() => undefined);
        return accepted;
      } finally {
        await unlink(merged).catch(() => undefined);
      }
    });
  }
}
