import PDFDocument from 'pdfkit';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
import { DocumentParser } from '../src/modules/documents/parsers/document.parser';
import { PageAssetsService } from '../src/modules/documents/page-assets.service';
import { MemoryStore } from '../src/persistence/memory.store';
import { localRendering } from '../src/modules/documents/parsers/vision-scheduler';

it('overlaps pages, keeps stable offsets and reuses cache across concurrency settings', async () => {
  const doc = new PDFDocument(),
    pieces: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    doc.on('data', (b) => pieces.push(b));
    doc.on('end', () => resolve(Buffer.concat(pieces)));
  });
  for (let n = 1; n <= 3; n++) {
    if (n > 1) doc.addPage();
    doc.text('Native page ' + n, 50, 50);
    doc.rect(50, 150, 200, 100).stroke();
  }
  doc.end();
  const input = await bytes,
    dir = await mkdtemp(join(tmpdir(), 'vision-parallel-'));
  let active = 0,
    peak = 0,
    calls = 0,
    delay = 150,
    aborted = 0,
    cancelOnThree = false,
    canceled = false;
  const llm: any = {
    complete: async (_: string, _key: any, images: any[], signal?: AbortSignal) => {
      active++;
      calls++;
      peak = Math.max(active, peak);
      if (cancelOnThree && active === 3) canceled = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal?.removeEventListener('abort', cancel);
            resolve();
          };
          const timer = setTimeout(finish, delay);
          const cancel = () => {
            clearTimeout(timer);
            aborted++;
            reject(signal?.reason);
          };
          signal?.addEventListener('abort', cancel, { once: true });
        });
        return JSON.stringify({ blocks: [{ type: 'figure', text: 'Diagram ' + images[0].label }] });
      } finally {
        active--;
      }
    },
  };
  const run = async (limit: number, root: string, extra: any = {}) => {
    const config = new ConfigService({ PAGE_ASSETS_DIR: root, VISION_CONCURRENCY: limit });
    return new DocumentParser(
      new PdfVisualService(config, llm, new PageAssetsService(config, new MemoryStore())),
    ).parseStructured(input, 'a.pdf', undefined, {
      userId: 1,
      documentId: 1,
      versionId: 1,
      ...extra,
    });
  };
  try {
    const progress: any[] = [];
    const parallel = await run(3, join(dir, 'parallel'), {
      stage: async (...args: any[]) => {
        progress.push(args);
      },
    });
    expect(progress[0]).toEqual(['vision', 0, null]);
    expect(progress.at(-1)).toEqual(['vision', 3, 3]);
    expect(peak).toBe(3);
    expect(localRendering.peak).toBe(1);
    for (const b of parallel.blocks)
      expect(parallel.text.slice(b.location.start, b.location.end)).toBe(b.text);
    peak = 0;
    await Promise.all([run(3, join(dir, 'session-a')), run(3, join(dir, 'session-b'))]);
    expect(peak).toBe(3);
    peak = 0;
    const serial = await run(1, join(dir, 'serial'));
    expect(peak).toBe(1);
    expect(serial).toEqual(parallel);
    const count = calls;
    expect(await run(1, join(dir, 'parallel'))).toEqual(parallel);
    expect(calls).toBe(count);
    delay = 1500;
    cancelOnThree = true;
    const error = new Error('canceled');
    const pending = run(3, join(dir, 'cancel'), {
      guard: async () => {
        if (canceled) throw error;
      },
    });
    await expect(pending).rejects.toBe(error);
    expect(active).toBe(0);
    expect(aborted).toBeGreaterThan(0);
    class Superseded extends Error {}
    await expect(
      run(3, join(dir, 'parallel'), {
        stage: async (_: string, _done: number, total: number | null) => {
          if (total === 3) throw new Superseded('replaced');
        },
      }),
    ).rejects.toBeInstanceOf(Superseded);
    expect(calls).toBe(count + 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
