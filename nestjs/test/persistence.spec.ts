import 'reflect-metadata';
import { MemoryStore } from '../src/persistence/memory.store';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { memoryUserRepository } from '../src/modules/auth/user-repository';

describe('memory repository and existing password compatibility', () => {
  it('does not commit failed transactions', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (tx) => {
        await tx.save('users', { username: 'rollback', password: 'hash' });
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    expect(await store.list('users')).toEqual([]);
  });
  it('does not lose concurrent writes when a transaction commits', async () => {
    const store = new MemoryStore();
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tx = store.transaction(async (s) => {
      await s.save('users', { username: 'transaction', password: 'x' });
      ready();
      await gate;
    });
    await started;
    const direct = store.save('users', { username: 'concurrent', password: 'x' });
    release();
    await Promise.all([tx, direct]);
    expect((await store.list('users')).map((r) => r.username).sort()).toEqual([
      'concurrent',
      'transaction',
    ]);
  });
  it('logs in an existing Java bcrypt $2a$ hash without changing it', async () => {
    const store = new MemoryStore();
    const password = (await hash('old-password', 10)).replace('$2b$', '$2a$');
    await store.save('users', { username: 'legacy', password });
    const auth = new AuthService(
      memoryUserRepository(store),
      new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '24h' } }),
    );
    const result = await auth.login('legacy', 'old-password');
    expect(result.username).toBe('legacy');
    expect(new JwtService({ secret: 'x'.repeat(32) }).verify(result.token).userId).toBe(1);
    expect((await store.list('users'))[0].password).toBe(password);
  });
});
