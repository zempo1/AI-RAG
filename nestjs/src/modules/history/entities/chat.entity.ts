import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chats')
export class Chat {
  @Column({ type: 'bigint', nullable: true, name: 'knowledge_base_id' })
  knowledgeBaseId: number | null;
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', name: 'user_id', nullable: true })
  userId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'created_at' })
  createdAt: string | null;
}
