import { Injectable } from '@nestjs/common';
import { Store, publicRow, Row } from '../persistence/store';
import { DocumentParser } from './parsers/document.parser';
import { RecursiveChunker } from './chunkers/recursive.chunker';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { VectorStore } from '../vector-store/vector-store.interface';
import { ApiError } from '../common/api-error';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly store: Store,
    private readonly parser: DocumentParser,
    private readonly chunker: RecursiveChunker,
    private readonly embeddings: EmbeddingsService,
    private readonly vectors: VectorStore,
  ) {}

  async ingest(bytes: Buffer, filename: string, userId: number): Promise<Row> {
    const content = await this.parser.parse(bytes, filename);
    const chunks = this.chunker.split(content);
    const vectors = await this.embeddings.embedDocuments(chunks);
    this.validateVectors(vectors, chunks.length);
    const doc = await this.store.save('documents', { userId, filename, content });
    this.vectors.addAll(
      vectors,
      chunks.map((text, chunkIndex) => ({
        text,
        userId,
        filename,
        documentId: doc.id,
        chunkIndex,
      })),
    );
    return doc;
  }

  private validateVectors(vectors: number[][], count: number): void {
    const dimension = vectors[0]?.length;
    if (
      vectors.length !== count ||
      !dimension ||
      vectors.some(
        (v) => v.length !== dimension || !v.every(Number.isFinite) || !v.some((x) => x !== 0),
      )
    )
      throw new Error('Invalid embedding response');
  }

  async owned(id: number, userId: number): Promise<Row> {
    const row = await this.store.get('documents', id);
    if (!row || row.userId !== userId) throw new ApiError(500, 'Document not found: ' + id);
    return row;
  }

  async latest(userId: number): Promise<Row> {
    const docs = await this.store.list('documents', { userId });
    docs.sort((a, b) => b.uploadTime.localeCompare(a.uploadTime) || b.id - a.id);
    if (!docs.length) throw new ApiError(500, 'No uploaded file found to generate mind map');
    return docs[0];
  }

  async list(userId: number) {
    return (await this.store.list('documents', { userId }))
      .sort((a, b) => b.uploadTime.localeCompare(a.uploadTime) || b.id - a.id)
      .map(({ id, filename, uploadTime }) => ({
        id,
        filename,
        uploadTime: uploadTime.replace(' ', 'T'),
      }));
  }

  async activate(id: number, userId: number): Promise<void> {
    const doc = await this.owned(id, userId);
    const chunks = this.chunker.split(doc.content);
    const vectors = await this.embeddings.embedDocuments(chunks);
    this.validateVectors(vectors, chunks.length);
    this.vectors.addAll(
      vectors,
      chunks.map((text, chunkIndex) => ({
        text,
        userId,
        filename: doc.filename,
        documentId: id,
        chunkIndex,
      })),
    );
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.owned(id, userId);
    await this.store.delete('documents', id);
  }
}
