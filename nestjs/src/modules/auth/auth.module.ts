import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';
import { Store } from '../../persistence/store';
import { MemoryStore } from '../../persistence/memory.store';
import { memoryUserRepository } from './user-repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.getOrThrow('JWT_SECRET'),
        signOptions: { algorithm: 'HS256', expiresIn: '24h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: getRepositoryToken(User),
      inject: [ConfigService, DataSource, Store],
      useFactory: (config: ConfigService, source: DataSource, store: Store) =>
        config.get('STORAGE_DRIVER') === 'memory'
          ? memoryUserRepository(store as MemoryStore)
          : source.getRepository(User),
    },
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
