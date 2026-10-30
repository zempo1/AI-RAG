import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey } from 'typeorm';

export class DocumentCascade1793376000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const maps = (await runner.getTable('mind_maps'))!;
    if (!maps.findColumnByName('document_id')) {
      const id = (await runner.getTable('document_files'))!.findColumnByName('id')!;
      await runner.addColumn(
        'mind_maps',
        new TableColumn({
          name: 'document_id',
          type: id.type,
          unsigned: id.unsigned,
          isNullable: true,
        }),
      );
    }
    for (const table of ['document_analyses', 'mind_maps']) {
      const orphan = await runner.query(
        `SELECT COUNT(*) AS count FROM ${table} a LEFT JOIN document_files d ON d.id=a.document_id WHERE a.document_id IS NOT NULL AND d.id IS NULL`,
      );
      if (Number(orphan[0].count)) {
        const metadata = (await runner.getTable(table))!;
        const sourceId = metadata.findColumnByName('document_id')!;
        if (!metadata.findColumnByName('legacy_document_id')) {
          await runner.addColumn(
            table,
            new TableColumn({
              name: 'legacy_document_id',
              type: sourceId.type,
              unsigned: sourceId.unsigned,
              isNullable: true,
            }),
          );
        }
        await runner.query(
          `UPDATE ${table} a LEFT JOIN document_files d ON d.id=a.document_id SET a.legacy_document_id=a.document_id, a.document_id=NULL WHERE a.document_id IS NOT NULL AND d.id IS NULL`,
        );
      }
      const metadata = (await runner.getTable(table))!;
      const existing = metadata.foreignKeys.filter(
        (key) => key.columnNames.length === 1 && key.columnNames[0] === 'document_id',
      );
      if (
        existing.some(
          (key) => key.referencedTableName === 'document_files' && key.onDelete === 'CASCADE',
        )
      )
        continue;
      for (const key of existing) await runner.dropForeignKey(table, key);
      await runner.createForeignKey(
        table,
        new TableForeignKey({
          name: `fk_${table}_source`,
          columnNames: ['document_id'],
          referencedTableName: 'document_files',
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        }),
      );
    }
  }

  async down(): Promise<void> {
    throw new Error('为保护关联数据，不自动移除来源关联');
  }
}
