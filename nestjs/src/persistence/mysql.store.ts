import { DataSource, EntityManager } from 'typeorm';
import { Store, Table, Row, now } from './store';
import { entityTargets } from './data-source';
import { ApiError } from '../common/api-error';

export class MysqlStore extends Store {
  constructor(private readonly manager: EntityManager) {
    super();
  }

  private name(table: Table) {
    return '`' + this.manager.connection.getMetadata(entityTargets[table]).tableName + '`';
  }

  private column(table: Table, property: string): string {
    const definition = this.manager.connection
      .getMetadata(entityTargets[table])
      .findColumnWithPropertyName(property);
    if (!definition) throw new Error('Unknown database column: ' + property);
    return '`' + definition.databaseName + '`';
  }

  private async query(sql: string, values: unknown[] = []): Promise<any> {
    const runner = this.manager.queryRunner || this.manager.connection.createQueryRunner();
    const zone = (this.manager.connection.options as any).timezone || '+08:00';
    try {
      await runner.query('SET SESSION time_zone = ?', [zone === 'Z' ? '+00:00' : zone]);
      return await runner.query(sql, values);
    } finally {
      if (!this.manager.queryRunner) await runner.release();
    }
  }

  private normalize(row: any): Row {
    for (const key of ['createdAt', 'uploadTime']) {
      const date = row[key];
      if (date instanceof Date) {
        const pad = (n: number, width = 2) => String(n).padStart(width, '0');
        row[key] =
          `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
      } else if (typeof date === 'string') row[key] = date.replace(' ', 'T');
    }
    for (const key of ['id', 'userId', 'documentId', 'chatId']) {
      if (row[key] != null) {
        row[key] = Number(row[key]);
        if (!Number.isSafeInteger(row[key]))
          throw new Error('Database ID exceeds JavaScript safe integer range');
      }
    }
    return row;
  }

  async list(table: Table, where: Record<string, unknown> = {}): Promise<Row[]> {
    const select = this.manager.connection
      .getMetadata(entityTargets[table])
      .columns.map((column) => column.propertyName)
      .map((k) => `${this.column(table, k)} AS \`${k}\``)
      .join(', ');
    const conditions = Object.keys(where)
      .map((k) => `${this.column(table, k)} = ?`)
      .join(' AND ');
    return (
      await this.query(
        `SELECT ${select} FROM ${this.name(table)}${conditions ? ' WHERE ' + conditions : ''}`,
        Object.values(where),
      )
    ).map((row: any) => this.normalize(row));
  }

  async get(table: Table, id: number): Promise<Row | undefined> {
    return (await this.list(table, { id }))[0];
  }

  async save(table: Table, row: Partial<Row>): Promise<Row> {
    const key = table === 'documents' ? 'uploadTime' : 'createdAt';
    try {
      // Bind wall-time strings directly. TypeORM datetime hydration otherwise
      // applies the host timezone before mysql2 applies DB_TIMEZONE a second time.
      const input = row.id ? row : { [key]: now(), ...row };
      const entries = Object.entries(input).filter(([k, v]) => k !== 'id' && v !== undefined);
      let id = row.id;
      if (id)
        await this.query(
          `UPDATE ${this.name(table)} SET ${entries.map(([k]) => this.column(table, k) + ' = ?').join(', ')} WHERE id = ?`,
          [...entries.map(([, v]) => v), id],
        );
      else {
        const result = await this.query(
          `INSERT INTO ${this.name(table)} (${entries.map(([k]) => this.column(table, k)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`,
          entries.map(([, v]) => v),
        );
        id = Number(result.insertId);
      }
      return (await this.get(table, id!))!;
    } catch (e: any) {
      if (e.code === 'ER_DUP_ENTRY') throw new ApiError(400, 'Username already exists');
      throw e;
    }
  }

  async delete(table: Table, id: number): Promise<void> {
    await this.query(`DELETE FROM ${this.name(table)} WHERE id = ?`, [id]);
  }

  async transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.manager.transaction((manager) => work(new MysqlStore(manager)));
  }
}

/** Read-only compatibility check: never synchronize or alter existing tables. */
export async function verifySchema(source: DataSource): Promise<void> {
  const runner = source.createQueryRunner();
  try {
    for (const target of Object.values(entityTargets)) {
      const metadata = source.getMetadata(target);
      const name = metadata.tableName;
      const actual = await runner.getTable(name);
      if (!actual) throw new Error(`MySQL 缺少表 ${name}；空库请显式运行 npm run migration:run`);
      for (const expected of metadata.columns) {
        const property = expected.propertyName;
        if (!expected) continue;
        const col = actual.findColumnByName(expected.databaseName);
        if (!col)
          throw new Error(
            `MySQL 表结构不兼容: ${name}.${expected.databaseName} 缺失；已有数据库请执行 npm run schema:upgrade`,
          );
        const compatible =
          col.type === expected.type ||
          (expected.type === 'bigint' && col.type === 'int') ||
          (expected.type === 'datetime' && col.type === 'timestamp');
        if (!compatible)
          throw new Error(`MySQL 表结构不兼容: ${name}.${col.name} 类型 ${col.type}`);
        if (property === 'id' && (!col.isPrimary || !col.isGenerated))
          throw new Error(`MySQL 表结构不兼容: ${name}.id 必须为自增主键`);
      }
    }
  } finally {
    await runner.release();
  }
}
