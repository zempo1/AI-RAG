import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ModelSettingsService } from './model-settings.service';
import { runWithModels } from './model-runtime';

@Injectable()
export class ModelContextInterceptor implements NestInterceptor {
  constructor(private readonly settings: ModelSettingsService) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    const userId = request.userId;
    // Management and read-only APIs must remain usable when a saved credential
    // cannot decrypt. All model-generating/ingestion endpoints are writes.
    if (!userId || ['GET', 'HEAD', 'DELETE'].includes(request.method) ||
      request.path === '/api/model-settings' || request.path.startsWith('/api/model-settings/')) return next.handle();
    const snapshot = await this.settings.resolveRuntime(userId);
    // Nest Observables are lazy: bind subscription, not just Observable creation.
    return new Observable(subscriber => runWithModels(snapshot, () => next.handle().subscribe(subscriber)));
  }
}
