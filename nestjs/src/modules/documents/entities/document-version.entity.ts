import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('document_versions')
export class DocumentVersion {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'document_id' }) documentId: number;
  @Column({ type: 'varchar', length: 255 }) filename: string;
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'original_path' }) originalPath:
    string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) sha256: string | null;
  @Column({ type: 'longtext', nullable: true }) content: string | null;
  @Column({ type: 'int', name: 'is_legacy', default: 0 }) isLegacy: number;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}

@Entity('document_index_revisions')
export class DocumentIndexRevision {
  @Column({ type: 'json', nullable: true, name: 'model_profile' }) modelProfile: Record<
    string,
    unknown
  > | null;
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'document_id' }) documentId: number;
  @Column({ type: 'bigint', name: 'version_id' }) versionId: number;
  @Column({ type: 'varchar', length: 255, name: 'embedding_fingerprint' })
  embeddingFingerprint: string;
  @Column({ type: 'varchar', length: 30 }) status: string;
  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'retired_at' }) retiredAt:
    string | null;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}

@Entity('document_chunks')
@Index(['indexRevisionId', 'chunkIndex'], { unique: true })
export class DocumentChunk {
  @Column({ type: 'json', nullable: true, name: 'retrieval_metadata' }) retrievalMetadata: Record<
    string,
    unknown
  > | null;
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'document_id' }) documentId: number;
  @Column({ type: 'bigint', name: 'version_id' }) versionId: number;
  @Column({ type: 'bigint', name: 'index_revision_id' }) indexRevisionId: number;
  @Column({ type: 'int', name: 'chunk_index' }) chunkIndex: number;
  @Column({ type: 'longtext' }) text: string;
  @Column({ type: 'json', nullable: true }) location: Record<string, unknown> | null;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}
