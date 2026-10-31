import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('knowledge_bases')
@Index(['userId', 'isDefault'], { unique: true })
export class KnowledgeBase {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'user_id' }) userId: number;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'int', nullable: true, name: 'is_default' }) isDefault: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'rebuild_task_id' }) rebuildTaskId: number | null;
  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'deleted_at' }) deletedAt:
    string | null;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}

@Entity('document_categories')
@Index(['knowledgeBaseId', 'name'], { unique: true })
export class DocumentCategory {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'knowledge_base_id' }) knowledgeBaseId: number;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}
