import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793203200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const names = [
      'app_user',
      'document_files',
      'chats',
      'messages',
      'document_analyses',
      'mind_maps',
    ];
    for (const name of names)
      if (await runner.hasTable(name))
        throw new Error(`拒绝初始化已有业务表 ${name}；请先核对现有数据库，禁止覆盖`);
    const base = 'id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY';
    const user = 'user_id BIGINT NULL';
    const end = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    await runner.query(
      `CREATE TABLE app_user (${base}, username VARCHAR(255) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, created_at DATETIME(6)) ${end}`,
    );
    await runner.query(
      `CREATE TABLE document_files (${base}, ${user}, filename VARCHAR(255), content LONGTEXT, upload_time DATETIME(6), FOREIGN KEY (user_id) REFERENCES app_user(id)) ${end}`,
    );
    await runner.query(
      `CREATE TABLE chats (${base}, ${user}, title VARCHAR(255), created_at DATETIME(6), FOREIGN KEY (user_id) REFERENCES app_user(id)) ${end}`,
    );
    await runner.query(
      `CREATE TABLE messages (${base}, chat_id BIGINT, role VARCHAR(255), content TEXT, created_at DATETIME(6), FOREIGN KEY (chat_id) REFERENCES chats(id)) ${end}`,
    );
    await runner.query(
      `CREATE TABLE document_analyses (${base}, ${user}, document_id BIGINT, document_name VARCHAR(255), type VARCHAR(255), content LONGTEXT, created_at DATETIME(6), FOREIGN KEY (user_id) REFERENCES app_user(id)) ${end}`,
    );
    await runner.query(
      `CREATE TABLE mind_maps (${base}, ${user}, title VARCHAR(255), data LONGTEXT, created_at DATETIME(6), FOREIGN KEY (user_id) REFERENCES app_user(id)) ${end}`,
    );
  }

  async down(): Promise<void> {
    throw new Error('为保护数据，不提供自动删表回滚；请使用已审核的数据库备份恢复流程');
  }
}
