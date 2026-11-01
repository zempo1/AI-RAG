import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';
import { entityTargets } from '../data-source';

/** Explicit and resumable. Existing vectors and historical citations are never rewritten. */
export class RagQuality1793491200000 implements MigrationInterface {
  async up(runner: QueryRunner) {
    for (const key of ['retrievalRuns', 'summaryCaches'] as const) {
      const metadata = runner.connection.getMetadata(entityTargets[key]);
      if (await runner.hasTable(metadata.tableName)) continue;
      await runner.createTable(
        new Table({
          name: metadata.tableName,
          columns: metadata.columns.map(
            (column) =>
              new TableColumn({
                name: column.databaseName,
                type: String(column.type),
                length: column.length,
                isPrimary: column.isPrimary,
                isGenerated: column.isGenerated,
                generationStrategy: column.generationStrategy,
                isNullable: column.isNullable,
                precision: column.precision,
              }),
          ),
          indices: metadata.indices.map(
            (index) =>
              new TableIndex({
                name: index.name,
                columnNames: index.columns.map((c) => c.databaseName),
                isUnique: index.isUnique,
              }),
          ),
        }),
        true,
      );
    }
    for (const key of ['indexRevisions', 'chunks', 'messages'] as const) {
      const metadata = runner.connection.getMetadata(entityTargets[key]);
      for (const column of metadata.columns) {
        if (await runner.hasColumn(metadata.tableName, column.databaseName)) continue;
        await runner.addColumn(
          metadata.tableName,
          new TableColumn({
            name: column.databaseName,
            type: String(column.type),
            length: column.length,
            isNullable: true,
            precision: column.precision,
          }),
        );
      }
    }
  }
  async down() {
    throw new Error('RAG quality upgrade requires an explicit restored backup to roll back');
  }
}
