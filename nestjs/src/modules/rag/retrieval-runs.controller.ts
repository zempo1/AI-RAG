import { Controller, Get, Param, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Store } from '../../persistence/store';
import { UserId } from '../auth/auth.guard';
import { IdPipe } from '../../common/pipes/id.pipe';
import { ApiError } from '../../common/api-error';
@Controller('api/retrieval-runs')
export class RetrievalRunsController implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: Store,
    @Optional() private readonly config?: ConfigService,
  ) {}
  private expired(value: unknown) {
    const text = String(value).replace(' ', 'T');
    const zone = this.config?.get<string>('DB_TIMEZONE') || '+08:00';
    const timestamp = Date.parse(
      /[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : text + (zone === 'Z' ? 'Z' : zone),
    );
    return !Number.isFinite(timestamp) || Date.now() - timestamp > 14 * 86400000;
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.purge().catch(() => undefined);
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async purge() {
    for (const row of await this.store.list('retrievalRuns'))
      if (this.expired(row.createdAt)) await this.store.delete('retrievalRuns', row.id);
  }
  @Get(':id') async get(@UserId() user: number, @Param('id', IdPipe) id: number) {
    const run = await this.store.get('retrievalRuns', id);
    if (!run || run.userId !== user || this.expired(run.createdAt))
      throw new ApiError(404, '检索记录不存在或已过期');
    return { id: run.id, createdAt: run.createdAt, ...run.payload };
  }
}
