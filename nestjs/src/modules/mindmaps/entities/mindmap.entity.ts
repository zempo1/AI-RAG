import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('mind_maps')
export class MindMap {
  @Column({ type: 'bigint', nullable: true, name: 'version_id' })
  versionId: number | null;
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', name: 'user_id', nullable: true })
  userId: number | null;

  @Column({ type: 'bigint', name: 'document_id', nullable: true })
  documentId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ type: 'longtext', nullable: true })
  data: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'created_at' })
  createdAt: string | null;
}
