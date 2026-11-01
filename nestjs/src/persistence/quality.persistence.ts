import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('retrieval_runs')
@Index(['userId', 'knowledgeBaseId'])
export class RetrievalRun {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'user_id' }) userId: number;
  @Column({ type: 'bigint', name: 'knowledge_base_id' }) knowledgeBaseId: number;
  @Column({ type: 'bigint', nullable: true, name: 'chat_id' }) chatId: number | null;
  @Column({ type: 'json' }) payload: Record<string, unknown>;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}

@Entity('summary_caches')
@Index(['cacheKey'], { unique: true })
@Index(['userId', 'knowledgeBaseId', 'indexRevisionId'])
export class SummaryCache {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'user_id' }) userId: number;
  @Column({ type: 'bigint', name: 'knowledge_base_id' }) knowledgeBaseId: number;
  @Column({ type: 'bigint', name: 'index_revision_id' }) indexRevisionId: number;
  @Column({ type: 'varchar', length: 191, name: 'cache_key' }) cacheKey: string;
  @Column({ type: 'json' }) payload: Record<string, unknown>;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}
