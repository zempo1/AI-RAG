import { MigrationInterface, QueryRunner } from "typeorm";
export class Quizzes1794873600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS quizzes (
      id BIGINT NOT NULL AUTO_INCREMENT, user_id BIGINT NOT NULL, knowledge_base_id BIGINT NOT NULL,
      document_id BIGINT NOT NULL, version_id BIGINT NOT NULL, index_revision_id BIGINT NOT NULL,
      title VARCHAR(255) NOT NULL, filename VARCHAR(255) NOT NULL, single_count INT NOT NULL,
      multiple_count INT NOT NULL, questions JSON NOT NULL, created_at DATETIME(6) NOT NULL,
      PRIMARY KEY(id), KEY ix_quiz_owner_library(user_id,knowledge_base_id),
      CONSTRAINT fk_quiz_user FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE,
      CONSTRAINT fk_quiz_document FOREIGN KEY(document_id) REFERENCES document_files(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await runner.query(`CREATE TABLE IF NOT EXISTS quiz_attempts (
      id BIGINT NOT NULL AUTO_INCREMENT, user_id BIGINT NOT NULL, quiz_id BIGINT NOT NULL,
      request_id VARCHAR(100) NOT NULL, current_index INT NOT NULL, status VARCHAR(20) NOT NULL,
      answers JSON NOT NULL, score DOUBLE NOT NULL, correct_count INT NOT NULL, answered_count INT NOT NULL,
      total_count INT NOT NULL, created_at DATETIME(6) NOT NULL, completed_at DATETIME(6) NULL,
      PRIMARY KEY(id), UNIQUE KEY uq_quiz_attempt_request(user_id,request_id), KEY ix_attempt_quiz(quiz_id),
      CONSTRAINT fk_attempt_quiz FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
      CONSTRAINT fk_attempt_user FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query("DROP TABLE IF EXISTS quiz_attempts");
    await runner.query("DROP TABLE IF EXISTS quizzes");
  }
}
