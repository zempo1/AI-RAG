import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

abstract class AgentCheckpointRow {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'varchar', length: 64, name: 'thread_id' }) threadId: string;
  @Column({ type: 'varchar', length: 191, name: 'checkpoint_ns' }) namespace: string;
  @Column({ type: 'varchar', length: 64, name: 'checkpoint_id' }) checkpointId: string;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}

@Entity('agent_checkpoints')
@Index('uq_agent_checkpoint', ['threadId', 'namespace', 'checkpointId'], { unique: true })
export class AgentCheckpoint extends AgentCheckpointRow {
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'parent_id' }) parentId: string | null;
  @Column({ type: 'longtext' }) checkpoint: string;
  @Column({ type: 'longtext' }) metadata: string;
}

@Entity('agent_checkpoint_writes')
@Index('uq_agent_checkpoint_write', ['threadId', 'namespace', 'checkpointId', 'taskId', 'writeIndex'], { unique: true })
export class AgentCheckpointWrite extends AgentCheckpointRow {
  @Column({ type: 'varchar', length: 64, name: 'task_id' }) taskId: string;
  @Column({ type: 'int', name: 'write_index' }) writeIndex: number;
  @Column({ type: 'text', name: 'task_path' }) taskPath: string;
  @Column({ type: 'text' }) channel: string;
  @Column({ type: 'longtext' }) value: string;
}
