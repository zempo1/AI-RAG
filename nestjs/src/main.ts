import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
  console.log(`AI-RAG NestJS listening on http://localhost:${port}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
