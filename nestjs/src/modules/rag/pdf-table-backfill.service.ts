import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { DocumentOriginalsService } from '../documents/document-originals.service';
import type { PdfTableLocation, ParsedDocument } from '../documents/parsers/parsed-document';
import { detectPdfTableGrids, linkAdjacentPageTables } from '../documents/parsers/pdf-table-layout';
import { textPositions, type TextPosition } from '../documents/parsers/pdf-layout';
import type { RetrievalSession } from './retrieval.types';

type Page = { tables: PdfTableLocation[]; texts: TextPosition[] };
/** Read-only compatibility for indexes built before table geometry was recorded. */
@Injectable()
export class PdfTableBackfillService {
  private readonly cache = new Map<string, Map<number, Page>>();
  constructor(private readonly originals: DocumentOriginalsService) {}

  async ensure(session: RetrievalSession, chunkIds: number[], signal?: AbortSignal) {
    const targets = new Map<string, { doc: number; version: number; pages: Set<number> }>();
    for (const id of chunkIds) {
      const chunk = session.byChunk.get(id),
        doc = chunk && session.byDoc.get(chunk.documentId);
      if (!chunk || !doc || !/\.pdf$/i.test(doc.filename) || !chunk.location?.page) continue;
      const key = `${chunk.documentId}:${chunk.versionId}`;
      const target = targets.get(key) || {
        doc: chunk.documentId,
        version: chunk.versionId,
        pages: new Set<number>(),
      };
      target.pages.add(chunk.location.page);
      targets.set(key, target);
    }
    for (const target of targets.values()) {
      signal?.throwIfAborted();
      let file: Awaited<ReturnType<DocumentOriginalsService['file']>>;
      try {
        file = await this.originals.file(session.scope.userId, target.doc, target.version);
      } catch (error: any) {
        if (error.getStatus?.() === 404) continue;
        throw error;
      }
      const info = await stat(file.path);
      const key = `${session.scope.userId}:${target.doc}:${target.version}:${file.path}:${info.size}:${info.mtimeMs}`;
      let pages = this.cache.get(key);
      if (!pages) {
        if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, (pages = new Map()));
      }
      const needed = new Set(
        [...target.pages].flatMap((p) => [p - 1, p, p + 1]).filter((p) => p > 0),
      );
      let extend = true;
      while (extend) {
        if ([...needed].some((p) => !pages!.has(p))) {
          const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
          const loading = pdfjs.getDocument({
            data: new Uint8Array(await readFile(file.path)),
            verbosity: 0,
            useSystemFonts: true,
          });
          try {
            const pdf = await loading.promise;
            for (const number of needed) {
              signal?.throwIfAborted();
              if (pages.has(number)) continue;
              if (number > pdf.numPages) {
                pages.set(number, { tables: [], texts: [] });
                continue;
              }
              const page = await pdf.getPage(number);
              try {
                const content = await page.getTextContent(),
                  viewport = page.getViewport({ scale: 1 });
                pages.set(number, {
                  tables: detectPdfTableGrids(
                    await page.getOperatorList(),
                    pdfjs.OPS,
                    viewport,
                    number,
                  ),
                  texts: textPositions(content, viewport),
                });
              } finally {
                page.cleanup();
              }
            }
          } finally {
            await loading.destroy();
          }
        }
        signal?.throwIfAborted();
        const docs = new Map<number, ParsedDocument>();
        for (const [number, page] of pages) {
          let text = '';
          const blocks: ParsedDocument['blocks'] = page.texts
            .filter((t) => t.text.trim())
            .map((t) => {
              const [x0, y0, x1, y1] = t.bbox,
                x = (x0 + x1) / 2,
                y = (y0 + y1) / 2;
              const table = page.tables.find(
                (g) => x >= g.bbox[0] && x <= g.bbox[2] && y >= g.bbox[1] && y <= g.bbox[3],
              );
              // Temporary PDF-item views for continuity checks; never become citations.
              const start = text.length;
              text += t.text + '\n';
              return {
                text: t.text,
                location: {
                  page: number,
                  start,
                  end: start + t.text.length,
                  paragraph: null,
                  heading: null,
                  contentType: 'native',
                  table,
                  anchorVersion: 1,
                  anchors: [
                    {
                      page: number,
                      start,
                      end: start + t.text.length,
                      kind: 'native',
                      rects: [t.bbox],
                    },
                  ],
                },
              };
            });
          docs.set(number, { text, blocks });
        }
        for (const number of [...docs.keys()].sort((a, b) => a - b)) {
          if (!docs.has(number + 1)) continue;
          linkAdjacentPageTables(docs.get(number)!, docs.get(number + 1)!);
        }
        for (const [number, doc] of docs)
          for (const block of doc.blocks) {
            const linked = block.location.table;
            const table = linked && pages.get(number)!.tables.find((t) => t.id === linked.id);
            if (table && linked) Object.assign(table, linked);
          }
        // Follow a proven continuation until its actual last page, in either direction.
        // A table ending near the foot of the middle page cannot be called complete yet.
        needed.clear();
        for (const [number, page] of pages)
          for (const table of page.tables) {
            if (table.continuedFrom && table.bbox[3] >= 0.72 && !pages.has(number + 1))
              needed.add(number + 1);
            if (table.continuedTo && number > 1 && table.bbox[1] <= 0.2 && !pages.has(number - 1))
              needed.add(number - 1);
          }
        extend = needed.size > 0;
      }
      session.tables ||= new Map();
      for (const chunk of session.chunks.filter(
        (c) => c.documentId === target.doc && c.versionId === target.version,
      )) {
        const number = chunk.location?.page,
          available = pages.get(number)?.tables;
        if (!available?.length || !chunk.location?.anchors?.some((a: any) => a.kind === 'native'))
          continue;
        session.tables.set(
          chunk.id,
          available
            .filter((table) =>
              chunk.location.anchors.some(
                (a: any) =>
                  a.kind === 'native' &&
                  a.rects.some(
                    (b: number[]) =>
                      (b[0] + b[2]) / 2 >= table.bbox[0] &&
                      (b[0] + b[2]) / 2 <= table.bbox[2] &&
                      (b[1] + b[3]) / 2 >= table.bbox[1] &&
                      (b[1] + b[3]) / 2 <= table.bbox[3],
                  ),
              ),
            )
            .map((table) => ({ page: number, table })),
        );
      }
    }
    signal?.throwIfAborted();
  }
}
