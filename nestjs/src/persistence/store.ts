export interface Row {
  id: number;
  [key: string]: any;
}

export interface EntityMap {
  retrievalRuns: import('./quality.persistence').RetrievalRun;
  summaryCaches: import('./quality.persistence').SummaryCache;
  knowledgeBases: import('../modules/knowledge-bases/entities/knowledge-base.entity').KnowledgeBase;
  categories: import('../modules/knowledge-bases/entities/knowledge-base.entity').DocumentCategory;
  versions: import('../modules/documents/entities/document-version.entity').DocumentVersion;
  indexRevisions: import('../modules/documents/entities/document-version.entity').DocumentIndexRevision;
  chunks: import('../modules/documents/entities/document-version.entity').DocumentChunk;
  tasks: import('../modules/tasks/entities/processing-task.entity').ProcessingTask;
  users: import('../modules/auth/entities/user.entity').User;
  documents: import('../modules/documents/entities/document.entity').DocumentFile;
  chats: import('../modules/history/entities/chat.entity').Chat;
  messages: import('../modules/history/entities/message.entity').Message;
  analyses: import('../modules/analysis/entities/document-analysis.entity').DocumentAnalysis;
  mindmaps: import('../modules/mindmaps/entities/mindmap.entity').MindMap;
}

export type Table = keyof EntityMap;

export abstract class Store {
  /** Transaction-only lock. Always lock library before document before task. */
  abstract lock(table: Table, id: number): Promise<Row | undefined>;
  abstract list(table: Table, where?: Record<string, unknown>): Promise<Row[]>;

  abstract get(table: Table, id: number): Promise<Row | undefined>;

  abstract save(table: Table, row: Partial<Row>): Promise<Row>;

  abstract delete(table: Table, id: number): Promise<void>;

  abstract transaction<T>(work: (store: Store) => Promise<T>): Promise<T>;
}

export const now = () => {
  const zone = process.env.DB_TIMEZONE || '+08:00';
  const match = /^([+-])(\d\d):(\d\d)$/.exec(zone);
  const minutes = match
    ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1)
    : 0;
  return new Date(Date.now() + minutes * 60000).toISOString().slice(0, 23);
};

export function publicRow(row: Row): Record<string, unknown> {
  const { userId, password, chatId, ...result } = row;
  for (const key of ['createdAt', 'uploadTime'])
    if (typeof result[key] === 'string') result[key] = result[key].replace(' ', 'T');
  return result;
}
