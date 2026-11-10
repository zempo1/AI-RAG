import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver, compareWritesSortKeys, ERROR, getCheckpointId, WRITES_IDX_MAP, writesSortKey,
} from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint, CheckpointListOptions, CheckpointMetadata, CheckpointTuple, PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { Store } from '../../persistence/store';
import type { AgentCheckpoint, AgentCheckpointWrite } from '../../persistence/agent-checkpoint.persistence';
import {
  AgentExecutionRevoked, AgentGraphOwner, agentThreadId, withAgentGraphOwner,
} from './agent-graph-owner';

export class MysqlAgentCheckpointer extends BaseCheckpointSaver {
  private readonly threadId: string;

  constructor(private readonly store: Store, private readonly owner: AgentGraphOwner) {
    super();
    this.threadId = agentThreadId(owner.taskId);
  }

  private key(config: RunnableConfig) {
    const threadId = config.configurable?.thread_id ?? this.threadId;
    if (threadId !== this.threadId) throw new AgentExecutionRevoked('任务检查点授权不匹配');
    return { threadId, namespace: String(config.configurable?.checkpoint_ns ?? '') };
  }

  private config(namespace: string, checkpointId: string): RunnableConfig {
    return { configurable: { thread_id: this.threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId } };
  }

  private async encode(value: unknown) {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    return `${type}:${Buffer.from(bytes).toString('base64')}`;
  }

  private async decode(value: string) {
    const separator = value.indexOf(':');
    return this.serde.loadsTyped(value.slice(0, separator), Buffer.from(value.slice(separator + 1), 'base64'));
  }

  private async tuple(tx: Store, row: AgentCheckpoint): Promise<CheckpointTuple> {
    const writes = await tx.list('agentCheckpointWrites', {
      threadId: row.threadId, namespace: row.namespace, checkpointId: row.checkpointId,
    }) as AgentCheckpointWrite[];
    writes.sort((a, b) => compareWritesSortKeys(
      writesSortKey(a.taskPath, a.taskId, a.writeIndex),
      writesSortKey(b.taskPath, b.taskId, b.writeIndex),
    ));
    return {
      config: this.config(row.namespace, row.checkpointId),
      checkpoint: await this.decode(row.checkpoint),
      metadata: await this.decode(row.metadata),
      parentConfig: row.parentId ? this.config(row.namespace, row.parentId) : undefined,
      pendingWrites: await Promise.all(writes.map(async write =>
        [write.taskId, write.channel, await this.decode(write.value)])),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const key = this.key(config);
    const checkpointId = getCheckpointId(config);
    return withAgentGraphOwner(this.store, this.owner, async tx => {
      const [row] = await tx.list('agentCheckpoints', checkpointId ? { ...key, checkpointId } : key,
        { orderBy: 'checkpointId', limit: 1 }) as AgentCheckpoint[];
      return row ? this.tuple(tx, row) : undefined;
    });
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}) {
    const key = this.key(config);
    const checkpointId = getCheckpointId(config);
    const before = options.before && getCheckpointId(options.before);
    const tuples = await withAgentGraphOwner(this.store, this.owner, async tx => {
      const rows = await tx.list('agentCheckpoints', {
        threadId: key.threadId,
        ...(config.configurable?.checkpoint_ns === undefined ? {} : { namespace: key.namespace }),
        ...(checkpointId ? { checkpointId } : {}),
      }) as AgentCheckpoint[];
      rows.sort((a, b) => a.checkpointId === b.checkpointId ? 0 : a.checkpointId > b.checkpointId ? -1 : 1);
      const result: CheckpointTuple[] = [];
      for (const row of rows) {
        if (options.limit !== undefined && result.length >= options.limit) break;
        if (before && row.checkpointId >= before) continue;
        const metadata = await this.decode(row.metadata);
        if (options.filter && !Object.entries(options.filter).every(([k, v]) => metadata[k] === v)) continue;
        result.push(await this.tuple(tx, row));
      }
      return result;
    });
    yield* tuples;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    const key = { ...this.key(config), checkpointId: checkpoint.id };
    const [encoded, encodedMetadata] = await Promise.all([this.encode(checkpoint), this.encode(metadata)]);
    await withAgentGraphOwner(this.store, this.owner, async (tx, task) => {
      const [existing] = await tx.list('agentCheckpoints', key);
      await tx.save('agentCheckpoints', {
        id: existing?.id, ...key, parentId: getCheckpointId(config) || null,
        checkpoint: encoded, metadata: encodedMetadata,
      });
      if (!key.namespace && checkpoint.channel_values.input && task.payload.snapshot) {
        // The imported input and the removal of its source snapshot must commit together.
        const { snapshot, ...payload } = task.payload;
        await tx.save('tasks', { id: task.id, payload });
      }
    });
    return this.config(key.namespace, key.checkpointId);
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = '') {
    const checkpointId = getCheckpointId(config);
    if (!checkpointId) throw new Error('Agent 待提交写入缺少检查点 ID');
    const key = { ...this.key(config), checkpointId, taskId };
    const encoded = await Promise.all(writes.map(async ([channel, value], index) => ({
      channel,
      // Provider errors can echo credentials. The graph only needs the error marker for recovery.
      value: await this.encode(channel === ERROR ? { name: 'Error', message: 'Agent 节点执行失败' } : value),
      writeIndex: WRITES_IDX_MAP[channel] ?? index,
    })));
    await withAgentGraphOwner(this.store, this.owner, async tx => {
      for (const write of encoded) {
        const [existing] = await tx.list('agentCheckpointWrites', { ...key, writeIndex: write.writeIndex });
        if (existing && write.writeIndex >= 0) continue;
        await tx.save('agentCheckpointWrites', { id: existing?.id, ...key, ...write, taskPath });
      }
    });
  }

  async deleteThread(threadId: string) {
    this.key({ configurable: { thread_id: threadId } });
    await withAgentGraphOwner(this.store, this.owner, tx => tx.deleteAgentThread(threadId));
  }
}
