import { ConfigService } from '@nestjs/config';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/persistence/memory.store';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';

it('authorizes region images and validates region identifiers', async () => {
  const region: any = { versionId: 3, page: 1, profile, regionId: 'b'.repeat(24) };
  const path = assets.directory({ userId: 1, documentId: 2, versionId: 3 }, profile);
  await writeFile(join(path, `1-${region.regionId}.png`), Buffer.from('crop'));
  expect((await (assets as any).regionImage(1, 2, region)).toString()).toBe('crop');
  await expect((assets as any).regionImage(2, 2, region)).rejects.toMatchObject({ status: 404 });
  await expect(
    (assets as any).regionImage(1, 2, { ...region, regionId: '../x' }),
  ).rejects.toThrow();
  await store.save('documents', { id: 2, deletedAt: 'now' });
  await expect((assets as any).regionImage(1, 2, region)).rejects.toMatchObject({ status: 404 });
});

let dir: string, store: MemoryStore, assets: PageAssetsService;
const profile = 'a'.repeat(64);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'page-assets-'));
  store = new MemoryStore();
  await store.save('knowledgeBases', { id: 1, userId: 1, deletedAt: null });
  await store.save('documents', { id: 2, userId: 1, knowledgeBaseId: 1, deletedAt: null });
  await store.save('versions', { id: 3, documentId: 2 });
  assets = new PageAssetsService(new ConfigService({ PAGE_ASSETS_DIR: dir }), store);
  const path = assets.directory({ userId: 1, documentId: 2, versionId: 3 }, profile);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, '1.png'), Buffer.from('fixture-image'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('authorizes library, document and historical version before reading a page', async () => {
  expect((await assets.image(1, 2, { versionId: 3, profile, page: 1 })).toString()).toBe(
    'fixture-image',
  );
  await expect(assets.image(9, 2, { versionId: 3, profile, page: 1 })).rejects.toThrow();
  await store.save('versions', { id: 4, documentId: 8 });
  await expect(assets.image(1, 2, { versionId: 4, profile, page: 1 })).rejects.toThrow();
  await store.save('knowledgeBases', { id: 1, deletedAt: 'deleted' });
  await expect(assets.image(1, 2, { versionId: 3, profile, page: 1 })).rejects.toThrow();
});

it('blocks traversal and deleted documents and removes only this document artifacts', async () => {
  await expect(
    assets.image(1, 2, { versionId: 3, profile: '../outside', page: 1 }),
  ).rejects.toThrow();
  await store.save('documents', { id: 2, deletedAt: 'deleted' });
  await expect(assets.image(1, 2, { versionId: 3, profile, page: 1 })).rejects.toThrow();
  await assets.removeDocument(1, 2);
  const { stat } = await import('node:fs/promises');
  await expect(stat(join(dir, '1', '2'))).rejects.toThrow();
  expect((await stat(dir)).isDirectory()).toBe(true);
});

it('loads at most three distinct source pages in retrieval order', async () => {
  const source = (page: number, number = page): any => ({
    number,
    documentId: 2,
    versionId: 3,
    location: { page, pageImage: { versionId: 3, page, profile } },
  });
  const path = assets.directory({ userId: 1, documentId: 2, versionId: 3 }, profile);
  for (const page of [2, 3, 4])
    await writeFile(join(path, `${page}.png`), Buffer.from('image' + page));
  const images = await assets.forSources(1, [
    source(2),
    source(2, 8),
    source(1),
    source(4),
    source(3),
  ]);
  expect(images).toHaveLength(3);
  expect(images.map((i) => i.label)).toEqual(['[2] 第2页', '[1] 第1页', '[4] 第4页']);
});
