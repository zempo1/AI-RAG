import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ChunkUploadService } from '../src/modules/documents/chunk-upload.service';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';

describe('chunk ingestion resource boundaries and retry', () => {
  let dir: string;
  let bytes = 0;
  let fail = false;
  let service: ChunkUploadService;
  const dto = { md5: 'a'.repeat(32), filename: 'file.md', totalChunks: 2 };
  const file = (size: number) => ({ size, buffer: Buffer.alloc(size, 'a') }) as Express.Multer.File;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-test-'));
    bytes = 0;
    fail = false;
    service = new ChunkUploadService(
      new ConfigService({ UPLOAD_TEMP_DIR: dir, MAX_DOCUMENT_BYTES: 12 * 1024 * 1024 }),
      {
        ingest: async (b: Buffer) => {
          if (fail) throw new Error('embedding failed');
          bytes = b.length;
          return { id: 1 };
        },
        owned: async () => ({ id: 1 }),
      } as any,
      new DocumentParser(),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('accepts merged documents above 10MiB but rejects above configured resource limit', async () => {
    await service.upload({ ...dto, chunkIndex: 0 }, file(6 * 1024 * 1024), 1);
    await service.upload({ ...dto, chunkIndex: 1 }, file(5 * 1024 * 1024), 1);
    await service.merge(dto, 1);
    expect(bytes).toBe(11 * 1024 * 1024);
    const other = { ...dto, md5: 'b'.repeat(32) };
    await service.upload({ ...other, chunkIndex: 0 }, file(7 * 1024 * 1024), 1);
    await service.upload({ ...other, chunkIndex: 1 }, file(6 * 1024 * 1024), 1);
    await expect(service.merge(other, 1)).rejects.toMatchObject({ status: 413 });
  });
  it('keeps chunks retryable after embeddings fail and never advertises false success', async () => {
    await service.upload({ ...dto, chunkIndex: 0 }, file(5), 1);
    await service.upload({ ...dto, chunkIndex: 1 }, file(6), 1);
    fail = true;
    await expect(service.merge(dto, 1)).rejects.toThrow('embedding failed');
    expect(await service.check(dto, 1)).toEqual({ uploaded: false, uploadedChunks: [0, 1] });
    fail = false;
    await service.merge(dto, 1);
    expect(await service.check(dto, 1)).toEqual({ uploaded: true });
  });
});
