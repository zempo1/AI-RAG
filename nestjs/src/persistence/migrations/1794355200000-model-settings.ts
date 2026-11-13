import { MigrationInterface, QueryRunner } from 'typeorm';

export class ModelSettings1794355200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS user_model_settings (
      id BIGINT NOT NULL AUTO_INCREMENT, user_id BIGINT NOT NULL,
      role VARCHAR(20) NOT NULL, binding JSON NOT NULL, encrypted_api_key TEXT NOT NULL,
      created_at DATETIME(6) NOT NULL, PRIMARY KEY (id),
      UNIQUE KEY uq_user_model_role (user_id, role),
      CONSTRAINT fk_model_settings_user FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(runner: QueryRunner): Promise<void> { await runner.query('DROP TABLE IF EXISTS user_model_settings'); }
}
