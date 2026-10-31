import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, UnrecoverableError, DelayedError } from 'bullmq';
import { Store, now } from '../../persistence/store';
import { IndexingService } from '../documents/indexing.service';
import { TasksService, terminalTask } from './tasks.service';

/** SQL is the outbox and source of truth; Redis only transports task ids. */
@Injectable()
export class TaskQueueRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskQueueRuntime.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopping = false;
  private activeDispatch?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly store: Store,
    private readonly indexing: IndexingService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    if (this.config.get('QUEUE_DRIVER') === 'bullmq') {
      for (const name of ['documents', 'cleanup']) {
        const queue = new Queue(name, {
          prefix: this.config.get('QUEUE_PREFIX'),
          connection: this.connection(false),
        });
        queue.on('error', () => this.logger.warn('Redis 暂不可用，任务保留在 MySQL 等待补投'));
        this.queues.set(name, queue);
        if (process.env.PROCESS_ROLE === 'worker') {
          const worker = new Worker(
            name,
            async (job) => {
              try {
                const result = await this.indexing.process(
                  job.data.taskId,
                  job.attemptsMade + 1,
                  (progress) => job.updateProgress(progress),
                );
                if (result === 'waiting') {
                  await job.moveToDelayed(Date.now() + 2000, job.token);
                  throw new DelayedError();
                }
              } catch (error) {
                const task = await this.store.get('tasks', job.data.taskId);
                if (task?.status === 'failed' && !task.retryable)
                  throw new UnrecoverableError(task.error || '文档处理失败');
                throw error;
              }
            },
            {
              prefix: this.config.get('QUEUE_PREFIX'),
              connection: this.connection(true),
              concurrency: 1,
            },
          );
          worker.on('error', () => this.logger.warn('Worker 等待 Redis 连接恢复'));
          worker.on('failed', (_job, error) => this.logger.warn('任务失败: ' + error.message));
          this.workers.push(worker);
        }
      }
    }
    this.timer = setInterval(() => {
      if (this.busy || this.stopping) return;
      this.activeDispatch = this.dispatch().catch((error) =>
        this.logger.warn('任务分发稍后重试: ' + error.message),
      );
    }, 1000);
    this.timer.unref();
  }

  private connection(worker: boolean) {
    const url = new URL(this.config.getOrThrow<string>('REDIS_URL'));
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: Number(url.pathname.slice(1) || 0),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      maxRetriesPerRequest: worker ? null : 1,
      enableOfflineQueue: worker,
      connectTimeout: 2000,
    };
  }

  async dispatch() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      const pending = (await this.store.list('tasks'))
        .filter(
          (t) =>
            t.kind !== 'rebuild' &&
            (!terminalTask(t.status) || (t.status === 'canceled' && t.executionToken)),
        )
        .sort((a, b) => a.id - b.id);
      for (const task of pending) {
        if (this.stopping) break;
        const notBefore = task.payload?.notBefore;
        const delay = notBefore
          ? Math.max(0, Date.parse(notBefore + 'Z') - Date.parse(now() + 'Z'))
          : 0;
        if (this.config.get('QUEUE_DRIVER') === 'memory') {
          if (delay) continue;
          try {
            await this.indexing.process(task.id, task.attempts + 1);
          } catch {
            /* Durable task status carries the failure; next tick retries. */
          }
        } else {
          const queue = this.queues.get(task.kind === 'index' ? 'documents' : 'cleanup');
          if (!queue) continue;
          const jobId = 'task-' + task.id + '-' + task.dispatchGeneration;
          const existing = await queue.getJob(jobId);
          if (existing) {
            const state = await existing.getState();
            if (!['failed', 'completed'].includes(state)) continue;
            // A crash between SQL completion and Redis ack can leave either side ahead.
            await existing.remove();
          }
          await queue.add(
            task.kind,
            { taskId: task.id },
            {
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 },
              delay,
              removeOnComplete: { count: 1000 },
              removeOnFail: { count: 1000 },
            },
          );
        }
      }
      for (const parent of (await this.store.list('tasks')).filter(
        (t) => t.kind === 'rebuild' && !terminalTask(t.status),
      ))
        await this.tasks.refreshParent(parent.id);
    } finally {
      this.busy = false;
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeDispatch;
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
