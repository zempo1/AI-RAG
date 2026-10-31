import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';
import { entityTargets } from '../data-source';

/** Explicit, resumable upgrade. Never invoked during application startup. */
export class KnowledgeBases1793404800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const newTables = [
      'knowledgeBases',
      'categories',
      'versions',
      'indexRevisions',
      'chunks',
      'tasks',
    ] as const;
    for (const key of newTables) {
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
                default: column.default === undefined ? undefined : String(column.default),
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
    for (const key of ['documents', 'chats', 'messages', 'analyses', 'mindmaps'] as const) {
      const metadata = runner.connection.getMetadata(entityTargets[key]);
      for (const column of metadata.columns) {
        if (await runner.hasColumn(metadata.tableName, column.databaseName)) continue;
        await runner.addColumn(
          metadata.tableName,
          new TableColumn({
            name: column.databaseName,
            type: String(column.type),
            length: column.length,
            precision: column.precision,
            isNullable: true,
          }),
        );
      }
    }
    await runner.query(
      "INSERT INTO knowledge_bases (user_id,name,description,is_default,created_at) SELECT u.id,'默认知识库','',1,NOW(6) FROM app_user u WHERE NOT EXISTS (SELECT 1 FROM knowledge_bases k WHERE k.user_id=u.id AND k.is_default=1)",
    );
    await runner.query(
      'UPDATE document_files d JOIN knowledge_bases k ON k.user_id=d.user_id AND k.is_default=1 SET d.knowledge_base_id=k.id WHERE d.knowledge_base_id IS NULL',
    );
    await runner.query(
      'UPDATE chats c JOIN knowledge_bases k ON k.user_id=c.user_id AND k.is_default=1 SET c.knowledge_base_id=k.id WHERE c.knowledge_base_id IS NULL',
    );
    await runner.query(
      "INSERT INTO document_versions (document_id,filename,content,is_legacy,created_at) SELECT d.id,COALESCE(d.filename,'legacy.md'),d.content,1,COALESCE(d.upload_time,NOW(6)) FROM document_files d WHERE d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id=d.id)",
    );
    await runner.query(
      'UPDATE document_files d JOIN document_versions v ON v.document_id=d.id SET d.active_version_id=v.id WHERE d.active_version_id IS NULL AND d.deleted_at IS NULL',
    );
    await runner.query("UPDATE document_files SET status='pending' WHERE status IS NULL");
    for (const [name, table, columns] of [
      ['idx_documents_library', 'document_files', ['knowledge_base_id', 'deleted_at']],
      ['idx_tasks_dispatch', 'processing_tasks', ['status', 'kind']],
      ['idx_tasks_library', 'processing_tasks', ['knowledge_base_id', 'document_id']],
      ['idx_versions_document', 'document_versions', ['document_id']],
      ['idx_revisions_document', 'document_index_revisions', ['document_id']],
    ] as const) {
      const existing = (await runner.getTable(table))!;
      if (!existing.indices.some((i) => i.name === name))
        await runner.createIndex(table, new TableIndex({ name, columnNames: [...columns] }));
    }
  }

  async down(): Promise<void> {
    throw new Error('为保护文档和聊天记录，不提供自动删表回滚');
  }
}
