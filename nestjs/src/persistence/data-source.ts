import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { schemas } from './entities';
import { InitialSchema1793203200000 } from './migrations/1793203200000-initial-schema';

export function mysqlOptions(env: Record<string, any>): DataSourceOptions {
  return {
    type: 'mysql',
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME || 'ai_rag',
    timezone: env.DB_TIMEZONE || '+08:00',
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    entities: Object.values(schemas),
    migrations: [InitialSchema1793203200000],
    synchronize: false,
    migrationsRun: false,
    connectTimeout: 5000,
    logging: false,
  };
}

export default new DataSource(mysqlOptions(process.env));
