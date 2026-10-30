import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateConfig } from './config/configuration';
import { PersistenceModule } from './persistence/persistence.module';
import { AuthModule } from './auth/auth.module';
import { DocumentsModule } from './documents/documents.module';
import { HistoryModule } from './history/history.module';
import { ChatModule } from './chat/chat.module';
import { AnalysisModule } from './analysis/analysis.module';
import { MindMapsModule } from './mindmaps/mindmaps.module';

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
