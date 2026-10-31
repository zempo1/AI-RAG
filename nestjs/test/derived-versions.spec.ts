import { pipeline } from './helpers/pipeline';
import { AnalysisService } from '../src/modules/analysis/analysis.service';
import { MindMapsService } from '../src/modules/mindmaps/mindmaps.service';

it('labels historical derived artifacts with their source version after replacement', async () => {
  const p = await pipeline();
  try {
    const file = await p.documents.ingest(Buffer.from('旧版来源'), 'a.md', 1);
    await p.indexing.process(file.taskId);
    const analyses = new AnalysisService(
      p.documents,
      { complete: async () => '摘要内容' } as any,
      p.store,
    );
    const maps = new MindMapsService(
      p.documents,
      { complete: async () => '{"root":{"data":{"text":"导图"},"children":[]}}' } as any,
      p.store,
    );
    const old = await analyses.generate(file.documentId, 'SUMMARY', 1);
    const map = await maps.generate(1, file.documentId);
    expect(old.versionId).toBe((await p.documents.owned(file.documentId, 1)).activeVersionId);
    const replacement = await p.documents.ingest(Buffer.from('新版来源'), 'a.md', 1, {
      documentId: file.documentId,
    });
    await p.indexing.process(replacement.taskId);
    expect((await analyses.list('SUMMARY', 1))[0].sourceOutdated).toBe(true);
    expect((await maps.list(1)).find((m) => m.id === map.id)?.sourceOutdated).toBe(true);
    const current = await analyses.generate(file.documentId, 'SUMMARY', 1);
    expect(current.versionId).not.toBe(old.versionId);
  } finally {
    await p.cleanup();
  }
});
