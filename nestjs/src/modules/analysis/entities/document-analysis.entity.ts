import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('document_analyses')
export class DocumentAnalysis {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', name: 'user_id', nullable: true })
  userId: number | null;

  @Column({ type: 'bigint', name: 'document_id', nullable: true })
  documentId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'document_name' })
  documentName: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  type: string | null;

  @Column({ type: 'longtext', nullable: true })
  content: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'created_at' })
  createdAt: string | null;
}
