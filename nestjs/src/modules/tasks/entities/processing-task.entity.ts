import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('processing_tasks')
@Index(['idempotencyKey'], { unique: true })
export class ProcessingTask {
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'execution_token' }) executionToken:
    string | null;
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'user_id' }) userId: number;
  @Column({ type: 'bigint', name: 'knowledge_base_id' }) knowledgeBaseId: number;
  @Column({ type: 'bigint', nullable: true, name: 'document_id' }) documentId: number | null;
  @Column({ type: 'bigint', nullable: true, name: 'index_revision_id' }) indexRevisionId:
    number | null;
  @Column({ type: 'bigint', nullable: true, name: 'parent_task_id' }) parentTaskId: number | null;
  @Column({ type: 'varchar', length: 191, nullable: true, name: 'idempotency_key' })
  idempotencyKey: string | null;
  @Column({ type: 'varchar', length: 30 }) kind: string;
  @Column({ type: 'varchar', length: 30 }) status: string;
  @Column({ type: 'varchar', length: 30 }) stage: string;
  @Column({ type: 'int', default: 0 }) completed: number;
  @Column({ type: 'int', nullable: true }) total: number | null;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: 'int', default: 0, name: 'dispatch_generation' }) dispatchGeneration: number;
  @Column({ type: 'int', default: 0, name: 'retryable' }) retryable: number;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ type: 'json', nullable: true }) payload: Record<string, unknown> | null;
  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'updated_at' }) updatedAt:
    string | null;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}
