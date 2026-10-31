import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

process.env.PROCESS_ROLE = 'worker';
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
