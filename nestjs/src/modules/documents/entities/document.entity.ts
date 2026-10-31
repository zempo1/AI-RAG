import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('document_files')
export class DocumentFile {
  @Column({ type: 'bigint', nullable: true, name: 'knowledge_base_id' })
  knowledgeBaseId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'category_id' })
  categoryId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'active_index_revision_id' })
  activeIndexRevisionId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'desired_index_revision_id' })
  desiredIndexRevisionId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'active_version_id' })
  activeVersionId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'latest_task_id' })
  latestTaskId: number | null;
  @Column({ type: 'varchar', length: 30, nullable: true })
  status: string | null;
  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'deleted_at' })
  deletedAt: string | null;
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', name: 'user_id', nullable: true })
  userId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  filename: string | null;

  @Column({ type: 'longtext', nullable: true })
  content: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'upload_time' })
  uploadTime: string | null;
}
