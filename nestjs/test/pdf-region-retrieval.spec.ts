import { pipeline } from './helpers/pipeline';
import { RagService } from '../src/modules/rag/rag.service';

it.each(['rerank', 'context'])(
  'preserves visual context without broadening source offsets: %s',
  async (check) => {
    const p = await pipeline();
    try {
      const text = 'FIGURE\n\nLEFT caption\n\nRIGHT secret';
      const accepted = await p.documents.ingest(Buffer.from(text), 'context.md', 1);
      await p.indexing.process(accepted.taskId);
      const doc = (await p.store.get('documents', accepted.documentId))!;
      for (const chunk of await p.store.list('chunks', { documentId: doc.id }))
        await p.store.delete('chunks', chunk.id);
      const location = {
        page: 1,
        paragraph: null,
        heading: null,
        start: 0,
        end: 6,
        contentType: 'figure',
        regionImage: {
          versionId: doc.activeVersionId,
          page: 1,
          profile: 'a'.repeat(64),
          regionId: 'b'.repeat(24),
          bbox: [0.1, 0.1, 0.4, 0.3],
          kind: 'region',
        },
      };
      const figure = await p.store.save('chunks', {
        documentId: doc.id,
        versionId: doc.activeVersionId,
        indexRevisionId: doc.activeIndexRevisionId,
        chunkIndex: 0,
        text: 'FIGURE',
        location,
        retrievalMetadata: {
          embeddingText: 'FIGURE\n付款审核流程',
          contextRanges: [{ start: 8, end: 20 }],
          parentId: 'figure',
          parentText: 'FIGURE',
          parentLocation: location,
        },
      });
      await p.store.save('chunks', {
        documentId: doc.id,
        versionId: doc.activeVersionId,
        indexRevisionId: doc.activeIndexRevisionId,
        chunkIndex: 1,
        text: text.slice(8),
        location: {
          page: 1,
          paragraph: 1,
          heading: null,
          start: 8,
          end: text.length,
          contentType: 'native',
        },
      });
      const seen: string[][] = [];
      const models: any = {
        rerank: async (_: string, docs: string[]) => {
          seen.push(docs);
          return docs.map((_, index) => ({ index, score: 1 }));
        },
      };
      p.config.set('STORAGE_DRIVER', 'mysql');
      const rag = new RagService(
        p.embeddings as any,
        {
          search: async () => [
            {
              segment: {
                chunkId: figure.id,
                documentId: doc.id,
                indexRevisionId: doc.activeIndexRevisionId,
              },
              score: 1,
            },
          ],
        } as any,
        p.store,
        p.libraries,
        undefined,
        models,
        p.config,
      );
      const result = await rag.prepare('付款审核流程', 1, accepted.knowledgeBaseId, {
        mode: 'search',
        documentIds: [doc.id],
      });
      if (check === 'rerank') expect(seen.flat().join('')).toContain('付款审核流程');
      else {
        const context = result.sources.find((s) => s.location?.contentType === 'native')!;
        expect(context.text).toBe('LEFT caption');
        expect(text.slice(context.location!.start, context.location!.end)).toBe(context.text);
        expect(result.prompt).not.toContain('RIGHT secret');
      }
    } finally {
      await p.cleanup();
    }
  },
);
