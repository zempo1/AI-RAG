import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('document_files')
export class DocumentFile {
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
