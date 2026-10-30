import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Store } from './store';
import { MemoryStore } from './memory.store';
import { MysqlStore, verifySchema } from './mysql.store';
import { mysqlOptions } from './data-source';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get('STORAGE_DRIVER') === 'memory'
          ? { type: 'mysql', manualInitialization: true, retryAttempts: 1 }
          : {
              ...mysqlOptions(
                Object.fromEntries(
                  ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_TIMEZONE'].map(
                    (k) => [k, config.get(k)],
                  ),
                ),
              ),
              retryAttempts: 1,
            },
    }),
  ],
  providers: [
    {
      provide: Store,
      inject: [ConfigService, DataSource],
      useFactory: async (config: ConfigService, source: DataSource) => {
        if (config.get('STORAGE_DRIVER') === 'memory') return new MemoryStore();
        await verifySchema(source);
        return new MysqlStore(source.manager);
      },
    },
  ],
  exports: [Store],
})
export class PersistenceModule {}
