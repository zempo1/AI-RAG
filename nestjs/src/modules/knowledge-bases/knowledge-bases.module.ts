import { Module } from '@nestjs/common';
import { KnowledgeBasesService } from './knowledge-bases.service';

@Module({ providers: [KnowledgeBasesService], exports: [KnowledgeBasesService] })
export class KnowledgeBasesModule {}
