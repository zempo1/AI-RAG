import { Store, Table, Row, now } from './store';
import { ApiError } from '../common/api-error';

export class MemoryStore extends Store {
  async lock(table: Table, id: number): Promise<Row | undefined> {
    return this.get(table, id);
  }
  private tables = new Map<Table, Map<number, Row>>();

  private counters = new Map<Table, number>();

  private serial: Promise<unknown> = Promise.resolve();

  private table(name: Table): Map<number, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  async list(table: Table, where: Record<string, unknown> = {}): Promise<Row[]> {
    return [...this.table(table).values()]
      .filter((row) => Object.entries(where).every(([k, v]) => row[k] === v))
      .map((r) => structuredClone(r));
  }

  async get(table: Table, id: number): Promise<Row | undefined> {
    const row = this.table(table).get(id);
    return row && structuredClone(row);
  }

  async save(table: Table, row: Partial<Row>): Promise<Row> {
    const execute = async () => {
      const rows = this.table(table);
      if (
        table === 'users' &&
        [...rows.values()].some((r) => r.username === row.username && r.id !== row.id)
      )
        throw new ApiError(400, 'Username already exists');
      const id = row.id ?? (this.counters.get(table) || 0) + 1;
      this.counters.set(table, Math.max(id, this.counters.get(table) || 0));
      const timeKey = table === 'documents' ? 'uploadTime' : 'createdAt';
      const defined = Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== undefined),
      );
      const result = { [timeKey]: now(), ...rows.get(id), ...defined, id } as Row;
      rows.set(id, structuredClone(result));
      return structuredClone(result);
    };
    const pending = this.serial.then(execute, execute);
    this.serial = pending.catch(() => undefined);
    return pending;
  }

  async delete(table: Table, id: number): Promise<void> {
    const execute = async () => {
      this.table(table).delete(id);
    };
    const pending = this.serial.then(execute, execute);
    this.serial = pending.catch(() => undefined);
    return pending;
  }

  async transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    const execute = async () => {
      const tx = new MemoryStore();
      tx.tables = structuredClone(this.tables);
      tx.counters = structuredClone(this.counters);
      const result = await work(tx);
      this.tables = tx.tables;
      this.counters = tx.counters;
      return result;
    };
    const pending = this.serial.then(execute, execute);
    this.serial = pending.catch(() => undefined);
    return pending;
  }
}
