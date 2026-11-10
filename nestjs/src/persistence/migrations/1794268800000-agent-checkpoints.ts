import { MigrationInterface, QueryRunner, Table } from 'typeorm';
import { AgentCheckpoint, AgentCheckpointWrite } from '../agent-checkpoint.persistence';

export class AgentCheckpoints1794268800000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const entity of [AgentCheckpoint, AgentCheckpointWrite]) {
      const metadata = runner.connection.getMetadata(entity);
      if (await runner.hasTable(metadata.tableName)) continue;
      await runner.createTable(new Table({
        name: metadata.tableName,
        columns: metadata.columns.map(column => ({
          name: column.databaseName,
          type: String(column.type),
          length: column.length,
          precision: column.precision,
          isPrimary: column.isPrimary,
          isGenerated: column.isGenerated,
          generationStrategy: column.generationStrategy,
          isNullable: column.isNullable,
        })),
        indices: metadata.indices.map(index => ({
          name: index.name,
          columnNames: index.columns.map(column => column.databaseName),
          isUnique: index.isUnique,
        })),
      }), true);
    }
  }

  async down() {
    throw new Error('请先排空 Agent v2 任务，再通过备份恢复旧数据库结构');
  }
}
