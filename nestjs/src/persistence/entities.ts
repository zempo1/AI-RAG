import { EntitySchema } from 'typeorm';
import { Table } from './store';

const id = { type: 'bigint' as const, primary: true, generated: 'increment' as const };

const varchar = (name?: string) => ({
  type: 'varchar' as const,
  length: 255,
  nullable: true,
  ...(name ? { name } : {}),
});

const longtext = { type: 'longtext' as const, nullable: true };

const timestamp = (name: string) => ({
  type: 'datetime' as const,
  precision: 6,
  nullable: true,
  name,
});

export const schemas: Record<Table, EntitySchema<any>> = {
  users: new EntitySchema({
    name: 'User',
    tableName: 'app_user',
    columns: {
      id,
      username: { ...varchar(), nullable: false, unique: true },
      password: { ...varchar(), nullable: false },
      createdAt: timestamp('created_at'),
    },
  }),
  documents: new EntitySchema({
    name: 'DocumentFile',
    tableName: 'document_files',
    columns: {
      id,
      userId: { type: 'bigint', name: 'user_id', nullable: true },
      filename: varchar(),
      content: longtext,
      uploadTime: timestamp('upload_time'),
    },
  }),
  chats: new EntitySchema({
    name: 'Chat',
    tableName: 'chats',
    columns: {
      id,
      userId: { type: 'bigint', name: 'user_id', nullable: true },
      title: varchar(),
      createdAt: timestamp('created_at'),
    },
  }),
  messages: new EntitySchema({
    name: 'Message',
    tableName: 'messages',
    columns: {
      id,
      chatId: { type: 'bigint', name: 'chat_id', nullable: true },
      role: varchar(),
      content: { type: 'text', nullable: true },
      createdAt: timestamp('created_at'),
    },
  }),
  analyses: new EntitySchema({
    name: 'DocumentAnalysis',
    tableName: 'document_analyses',
    columns: {
      id,
      userId: { type: 'bigint', name: 'user_id', nullable: true },
      documentId: { type: 'bigint', name: 'document_id', nullable: true },
      documentName: varchar('document_name'),
      type: varchar(),
      content: longtext,
      createdAt: timestamp('created_at'),
    },
  }),
  mindmaps: new EntitySchema({
    name: 'MindMap',
    tableName: 'mind_maps',
    columns: {
      id,
      userId: { type: 'bigint', name: 'user_id', nullable: true },
      title: varchar(),
      data: longtext,
      createdAt: timestamp('created_at'),
    },
  }),
};
