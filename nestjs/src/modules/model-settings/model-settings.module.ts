import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ModelSettingsController } from './model-settings.controller';
import { ModelSettingsService } from './model-settings.service';
import { ModelContextInterceptor } from './model-context.interceptor';

@Global()
@Module({ controllers: [ModelSettingsController], providers: [ModelSettingsService,
  { provide: APP_INTERCEPTOR, useClass: ModelContextInterceptor }], exports: [ModelSettingsService] })
export class ModelSettingsModule {}
