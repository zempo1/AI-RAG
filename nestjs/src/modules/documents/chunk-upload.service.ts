import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { DocumentParser } from './parsers/document.parser';
import { DocumentsService } from './documents.service';
import { ChunkDto, MergeDto, UploadCheckDto } from './dto/upload.dto';
import { ApiError } from '../../common/api-error';

@Injectable()
export class ChunkUploadService {
  private readonly complete = new Map<string, number>();

  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
    private readonly parser: DocumentParser,
  ) {}

  private key(userId: number, dto: UploadCheckDto) {
    this.parser.validateFilename(dto.filename);
    return `${userId}-${dto.md5.toLowerCase()}-${createHash('sha256').update(dto.filename).digest('hex')}`;
  }

  private directory(key: string) {
    return join(this.config.getOrThrow<string>('UPLOAD_TEMP_DIR'), key);
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

  async check(dto: UploadCheckDto, userId: number) {
    const key = this.key(userId, dto);
    return this.locked(key, async () => {
      const id = this.complete.get(key);
      if (id) {
        try {
          await this.documents.owned(id, userId);
          return { uploaded: true };
        } catch {
          this.complete.delete(key);
        }
      }
      let files: string[];
      try {
        files = await readdir(this.directory(key));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
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

  async upload(dto: ChunkDto, file: Express.Multer.File | undefined, userId: number) {
    const key = this.key(userId, dto);
    if (!file?.size) throw new ApiError(400, '分片不能为空');
    if (dto.chunkIndex >= dto.totalChunks) throw new ApiError(400, '分片编号超出范围');
    return this.locked(key, async () => {
      const dir = this.directory(key);
      await mkdir(dir, { recursive: true });
      const metadata = join(dir, 'metadata.json');
      try {
        if (JSON.parse(await readFile(metadata, 'utf8')).totalChunks !== dto.totalChunks)
          throw new ApiError(400, '分片总数不一致');
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        await writeFile(metadata, JSON.stringify({ totalChunks: dto.totalChunks }));
      }
      const temp = join(dir, `pending_${randomUUID()}`);
      try {
        await writeFile(temp, file.buffer);
        await rename(temp, join(dir, `chunk_${dto.chunkIndex}`));
      } finally {
        await rm(temp, { force: true });
      }
      return { chunkIndex: dto.chunkIndex, received: true };
    });
  }

  async merge(dto: MergeDto, userId: number) {
    const key = this.key(userId, dto);
    return this.locked(key, async () => {
      const id = this.complete.get(key);
      if (id) {
        try {
          await this.documents.owned(id, userId);
          return { message: 'File uploaded and ingested successfully.', filename: dto.filename };
        } catch {
          this.complete.delete(key);
        }
      }
      const dir = this.directory(key);
      let totalBytes = 0;
      for (let i = 0; i < dto.totalChunks; i++) {
        try {
          totalBytes += (await stat(join(dir, `chunk_${i}`))).size;
        } catch (e: any) {
          if (e.code === 'ENOENT') throw new ApiError(400, 'Missing chunk: ' + i);
          throw e;
        }
        if (totalBytes > this.config.getOrThrow<number>('MAX_DOCUMENT_BYTES'))
          throw new ApiError(413, '文件超过文档解析大小限制');
      }
      const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
      if (metadata.totalChunks !== dto.totalChunks) throw new ApiError(400, '分片总数不一致');
      const merged = join(dir, 'merge_' + randomUUID());
      const output = await open(merged, 'wx');
      try {
        for (let i = 0; i < dto.totalChunks; i++) {
          for await (const buffer of createReadStream(join(dir, `chunk_${i}`)))
            await output.writeFile(buffer);
        }
      } finally {
        await output.close();
      }
      let document;
      try {
        document = await this.documents.ingest(await readFile(merged), dto.filename, userId);
      } finally {
        await rm(merged, { force: true });
      }
      this.complete.set(key, document.id);
      // Cleanup failures must not turn a completed ingestion into a duplicate retry.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return { message: 'File uploaded and ingested successfully.', filename: dto.filename };
    });
  }
}
