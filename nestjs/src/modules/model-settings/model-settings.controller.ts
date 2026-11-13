import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { UserId } from '../auth/auth.guard';
import { ModelSettingsService } from './model-settings.service';
import type { SaveModelSetting } from './model-settings.service';

@Controller('api/model-settings')
export class ModelSettingsController {
  constructor(private readonly settings: ModelSettingsService) {}
  @Get() list(@UserId() userId: number) { return this.settings.list(userId); }
  @Put(':role') save(@UserId() userId: number, @Param('role') role: string, @Body() body: SaveModelSetting) {
    return this.settings.save(userId, role, body);
  }
  @Delete(':role') reset(@UserId() userId: number, @Param('role') role: string) {
    return this.settings.reset(userId, role);
  }
}
