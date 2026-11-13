import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { MemoryStore } from '../src/persistence/memory.store';
import {
  DocumentOriginalsService,
  byteRange,
} from '../src/modules/documents/document-originals.service';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DocumentsController } from '../src/modules/documents/documents.controller';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { ChunkUploadService } from '../src/modules/documents/chunk-upload.service';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { configureApp } from '../src/bootstrap';

let root: string, store: MemoryStore, originals: DocumentOriginalsService;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rag-original-'));
  store = new MemoryStore();
  await store.save('knowledgeBases', { id: 1, userId: 1 });
  await store.save('documents', { id: 2, userId: 1, knowledgeBaseId: 1, activeVersionId: 3 });
  await store.save('versions', {
    id: 3,
    documentId: 2,
    filename: '原件.pdf',
    originalPath: 'old.pdf',
  });
  await store.save('versions', {
    id: 4,
    documentId: 2,
    filename: '新版.pdf',
    originalPath: 'new.pdf',
  });
  await writeFile(join(root, 'old.pdf'), '%PDF-old');
  await writeFile(join(root, 'new.pdf'), '%PDF-new');
  originals = new DocumentOriginalsService(new ConfigService({ ORIGINALS_DIR: root }), store);
});
afterEach(() => rm(root, { recursive: true, force: true }));

it('resolves active, historical and first pending originals without exposing paths', async () => {
  expect(await originals.preview(1, 2)).toMatchObject({
    versionId: 3,
    originalAvailable: true,
    mimeType: 'application/pdf',
  });
  const old = await originals.preview(1, 2, 3);
  expect(JSON.stringify(old)).not.toContain(root);
  expect(JSON.stringify(old)).not.toContain('old.pdf');
  await store.save('documents', { id: 2, activeVersionId: null });
  expect((await originals.preview(1, 2)).versionId).toBe(4);
  expect((await originals.preview(1, 2, 3)).versionId).toBe(3);
});

it('checks document, library and historical version ownership', async () => {
  await expect(originals.preview(9, 2, 3)).rejects.toMatchObject({ status: 404 });
  await store.save('versions', { id: 5, documentId: 99, originalPath: 'old.pdf' });
  await expect(originals.preview(1, 2, 5)).rejects.toMatchObject({ status: 404 });
  await store.save('knowledgeBases', { id: 1, deletedAt: 'deleted' });
  await expect(originals.file(1, 2, 3)).rejects.toMatchObject({ status: 404 });
});

it('previews uploaded Markdown before indexing has produced a text snapshot', async () => {
  await writeFile(join(root, 'notes.md'), '# 尚未索引\n\n原文仍可查看。');
  await store.save('versions', {
    id: 6,
    documentId: 2,
    filename: 'notes.md',
    originalPath: 'notes.md',
    content: null,
  });
  expect(await originals.preview(1, 2, 6)).toMatchObject({
    mimeType: 'text/markdown',
    text: '# 尚未索引\n\n原文仍可查看。',
  });
});

it('reports missing originals and blocks traversal and deleted sources', async () => {
  await store.save('versions', { id: 3, originalPath: 'absent.pdf' });
  expect((await originals.preview(1, 2, 3)).originalAvailable).toBe(false);
  await expect(originals.file(1, 2, 3)).rejects.toMatchObject({ status: 404 });
  await store.save('versions', { id: 3, originalPath: '../outside.pdf' });
  await expect(originals.file(1, 2, 3)).rejects.toMatchObject({ status: 400 });
  await store.save('documents', { id: 2, deletedAt: 'deleted' });
  await expect(originals.preview(1, 2, 3)).rejects.toMatchObject({ status: 404 });
});

it('serves byte ranges including open and suffix ranges without reading all bytes', () => {
  expect(byteRange(undefined, 100)).toBeNull();
  expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  expect(byteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 });
  for (const value of ['bytes=100-', 'bytes=9-2', 'bytes=-0', 'bytes=1-2,4-5', 'nonsense'])
    expect(() => byteRange(value, 100)).toThrow();
});

it('returns raw private PDF bytes, HEAD headers and partial content through the real controller', async () => {
  const module = await Test.createTestingModule({
    controllers: [DocumentsController],
    providers: [
      { provide: DocumentsService, useValue: {} },
      { provide: ChunkUploadService, useValue: {} },
      { provide: PageAssetsService, useValue: {} },
      { provide: DocumentOriginalsService, useValue: originals },
    ],
  }).compile();
  const app = module.createNestApplication();
  configureApp(app);
  app.useGlobalGuards({
    canActivate(context) {
      const req = context.switchToHttp().getRequest();
      req.userId = req.headers.authorization === 'Bearer owner' ? 1 : 9;
      return true;
    },
  });
  await app.init();
  try {
    const url = '/api/documents/2/versions/3/original';
    const get = () => request(app.getHttpServer()).get(url).set('Authorization', 'Bearer owner');
    const result = await get()
      .expect(200)
      .expect('Content-Type', /application\/pdf/);
    expect(result.body).toEqual(Buffer.from('%PDF-old'));
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['accept-ranges']).toBe('bytes');
    const partial = await get().set('Range', 'bytes=1-3').expect(206);
    expect(partial.headers['content-range']).toBe('bytes 1-3/8');
    expect(partial.body).toEqual(Buffer.from('PDF'));
    const head = await request(app.getHttpServer())
      .head(url)
      .set('Authorization', 'Bearer owner')
      .expect(200);
    expect(head.headers['content-length']).toBe('8');
    expect(head.text).toBeUndefined();
    await get().set('Range', 'bytes=99-').expect(416).expect('Content-Range', 'bytes */8');
    await request(app.getHttpServer()).get(url).expect(404);
    const preview = await request(app.getHttpServer())
      .get('/api/documents/2/preview')
      .set('Authorization', 'Bearer owner')
      .expect(200);
    expect(preview.body.data.versionId).toBe(3);
    await request(app.getHttpServer())
      .get('/api/documents/2/preview?versionId=nope')
      .set('Authorization', 'Bearer owner')
      .expect(400);
  } finally {
    await app.close();
  }
});
