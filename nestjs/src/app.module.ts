import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/configuration';
import { PersistenceModule } from './persistence/persistence.module';
import { AuthModule } from './modules/auth/auth.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { HistoryModule } from './modules/history/history.module';
import { ChatModule } from './modules/chat/chat.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { MindMapsModule } from './modules/mindmaps/mindmaps.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateConfig }),
    PersistenceModule,
    AuthModule,
    DocumentsModule,
    HistoryModule,
    ChatModule,
    AnalysisModule,
    MindMapsModule,
  ],
})
export class AppModule {}
