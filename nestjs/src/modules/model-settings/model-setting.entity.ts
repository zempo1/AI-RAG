import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_model_settings')
@Index(['userId', 'role'], { unique: true })
export class ModelSetting {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: number;
  @Column({ type: 'bigint', name: 'user_id' }) userId: number;
  @Column({ type: 'varchar', length: 20 }) role: string;
  @Column({ type: 'json' }) binding: Record<string, unknown>;
  @Column({ type: 'text', name: 'encrypted_api_key' }) encryptedApiKey: string;
  @Column({ type: 'datetime', precision: 6, name: 'created_at' }) createdAt: string;
}
