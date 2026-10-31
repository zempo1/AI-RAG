import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from './helpers/pipeline';
import { ChunkUploadService } from '../src/modules/documents/chunk-upload.service';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';

describe('resumable upload resource boundaries and persistent idempotency', () => {
  let p: Awaited<ReturnType<typeof pipeline>>, service: ChunkUploadService;
  const file = (bytes: Buffer) => ({ size: bytes.length, buffer: bytes }) as Express.Multer.File;
  const dto = (bytes: Buffer, uploadId = 'test-upload') => ({
    filename: 'file.md',
    md5: createHash('md5').update(bytes).digest('hex'),
    totalChunks: 2,
    uploadId,
  });
  beforeEach(async () => {
    p = await pipeline();
    p.config.set('UPLOAD_TEMP_DIR', join(p.config.getOrThrow('ORIGINALS_DIR'), 'chunks'));
    p.config.set('MAX_DOCUMENT_BYTES', 12 * 1024 * 1024);
    service = new ChunkUploadService(p.config, p.documents, new DocumentParser());
  });
  afterEach(async () => {
    await p.cleanup();
  });
  it('accepts merged files larger than 10 MiB and rejects the configured parsing resource limit', async () => {
    const bytes = Buffer.alloc(11 * 1024 * 1024, 'a'),
      meta = dto(bytes);
    await service.upload({ ...meta, chunkIndex: 0 }, file(bytes.subarray(0, 6 * 1024 * 1024)), 1);
    await service.upload({ ...meta, chunkIndex: 1 }, file(bytes.subarray(6 * 1024 * 1024)), 1);
    const accepted = await service.merge(meta, 1);
    expect((await p.tasks.get(accepted.taskId, 1)).status).toBe('queued');
    const large = Buffer.alloc(13 * 1024 * 1024, 'a'),
      largeMeta = dto(large, 'large');
    await service.upload(
      { ...largeMeta, chunkIndex: 0 },
      file(large.subarray(0, 7 * 1024 * 1024)),
      1,
    );
    await service.upload({ ...largeMeta, chunkIndex: 1 }, file(large.subarray(7 * 1024 * 1024)), 1);
    await expect(service.merge(largeMeta, 1)).rejects.toMatchObject({ status: 413 });
  });
  it('restores partial uploads and completed submissions after service recreation without cross-library quick uploads', async () => {
    const bytes = Buffer.from('hello中文'),
      meta = dto(bytes);
    await service.upload({ ...meta, chunkIndex: 0 }, file(bytes.subarray(0, 5)), 1);
    service = new ChunkUploadService(p.config, p.documents, new DocumentParser());
    expect((await service.check(meta, 1)).uploadedChunks).toEqual([0]);
    await service.upload({ ...meta, chunkIndex: 1 }, file(bytes.subarray(5)), 1);
    const accepted = await service.merge(meta, 1);
    service = new ChunkUploadService(p.config, p.documents, new DocumentParser());
    expect(await service.check(meta, 1)).toMatchObject({
      uploaded: true,
      documentId: accepted.documentId,
      taskId: accepted.taskId,
    });
    expect(await service.merge(meta, 1)).toEqual(accepted);
    const other = await p.libraries.create(1, '另一个库');
    expect(await service.check({ ...meta, knowledgeBaseId: other.id }, 1)).toEqual({
      uploaded: false,
      uploadedChunks: [],
    });
  });
  it('rejects corrupted chunks instead of publishing a successful upload', async () => {
    const meta = dto(Buffer.from('expected'));
    await service.upload({ ...meta, chunkIndex: 0 }, file(Buffer.from('bad')), 1);
    await service.upload({ ...meta, chunkIndex: 1 }, file(Buffer.from('data')), 1);
    await expect(service.merge(meta, 1)).rejects.toMatchObject({ status: 400 });
    expect(await p.store.list('tasks')).toHaveLength(0);
  });
});
