import { Row, Store } from '../../persistence/store';

export interface AgentGraphOwner {
  taskId: number;
  token: string;
}

export class AgentExecutionRevoked extends Error {
  readonly retryable = false;

  constructor(message = '任务已停止或执行权已变化') {
    super(message);
    this.name = 'AgentExecutionRevoked';
  }
}

export const agentThreadId = (taskId: number) => `qa:${taskId}:v2`;

export async function withAgentGraphOwner<T>(
  store: Store,
  owner: AgentGraphOwner,
  work: (tx: Store, task: Row) => Promise<T>,
): Promise<T> {
  const current = await store.get('tasks', owner.taskId);
  if (!current) throw new AgentExecutionRevoked();
  return store.transaction(async tx => {
    const kb = await tx.lock('knowledgeBases', current.knowledgeBaseId);
    const task = await tx.lock('tasks', owner.taskId);
    if (!kb || kb.deletedAt || !task || task.kind !== 'qa' ||
        task.userId !== kb.userId || task.knowledgeBaseId !== kb.id ||
        task.status !== 'running' || task.executionToken !== owner.token ||
        task.payload?.graphVersion !== 2 || task.payload.graphThreadId !== agentThreadId(task.id))
      throw new AgentExecutionRevoked();
    const chat = await tx.get('chats', task.payload.chatId);
    if (!chat || chat.userId !== task.userId || chat.knowledgeBaseId !== kb.id)
      throw new AgentExecutionRevoked('会话不可用');
    return work(tx, task);
  });
}
