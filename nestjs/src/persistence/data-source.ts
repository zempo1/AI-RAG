import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { User } from '../modules/auth/entities/user.entity';
import { DocumentFile } from '../modules/documents/entities/document.entity';
import { Chat } from '../modules/history/entities/chat.entity';
import { Message } from '../modules/history/entities/message.entity';
import { DocumentAnalysis } from '../modules/analysis/entities/document-analysis.entity';
import { MindMap } from '../modules/mindmaps/entities/mindmap.entity';

export const entityTargets = {
  users: User,
  documents: DocumentFile,
  chats: Chat,
  messages: Message,
  analyses: DocumentAnalysis,
  mindmaps: MindMap,
};
import { InitialSchema1793203200000 } from './migrations/1793203200000-initial-schema';
import { DocumentCascade1793376000000 } from './migrations/1793376000000-document-cascade';

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
    entities: Object.values(entityTargets),
    migrations: [InitialSchema1793203200000, DocumentCascade1793376000000],
    synchronize: false,
    migrationsRun: false,
    connectTimeout: 5000,
    logging: false,
  };
}

export default new DataSource(mysqlOptions(process.env));
