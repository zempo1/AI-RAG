import type { DeepPartial, FindOptionsWhere } from 'typeorm';
import type { User } from './entities/user.entity';
import { MemoryStore } from '../../persistence/memory.store';

/** The authentication module only needs these standard Repository operations. */
export interface UserRepository {
  findOneBy(where: FindOptionsWhere<User>): Promise<User | null>;
  save(user: DeepPartial<User>): Promise<User>;
  update(id: number, changes: Partial<Pick<User, 'username' | 'password'>>): Promise<unknown>;
}

/** Explicit memory-mode adapter; production uses TypeORM's actual Repository<User>. */
export function memoryUserRepository(store: MemoryStore): UserRepository {
  const hydrate = (row: any): User | null =>
    row
      ? {
          id: row.id,
          username: row.username,
          password: row.password,
          createdAt: row.createdAt ? new Date(row.createdAt) : null,
        }
      : null;
  return {
    async findOneBy(where) {
      return hydrate((await store.list('users', where))[0]);
    },
    async save(user) {
      const row = await store.save('users', {
        ...user,
        createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : undefined,
      });
      return hydrate(row)!;
    },
    async update(id, changes) {
      const existing = await store.get('users', id);
      if (existing) await store.save('users', { ...existing, ...changes });
    },
  };
}
