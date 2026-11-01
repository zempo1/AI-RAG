import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('messages')
export class Message {
  @Column({ type: 'json', nullable: true, name: 'retrieval_context' }) retrievalContext: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'bigint', nullable: true, name: 'retrieval_run_id' }) retrievalRunId:
    number | null;
  @Column({ type: 'json', nullable: true }) diagnostics: Record<string, unknown> | null;
  @Column({ type: 'json', nullable: true })
  citations: unknown[] | null;
  @Column({ type: 'varchar', length: 30, nullable: true, name: 'generation_status' })
  generationStatus: string | null;
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', name: 'chat_id', nullable: true })
  chatId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  role: string | null;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'created_at' })
  createdAt: string | null;
}
