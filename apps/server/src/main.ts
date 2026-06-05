import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const globalApiPrefix = config.get<string>('GLOBAL_API_PREFIX')?.trim();
  if (!globalApiPrefix) {
    console.error(
      'GLOBAL_API_PREFIX is required. Set it in .env or the environment before starting the server.',
    );
    process.exit(1);
  }
  app.setGlobalPrefix(globalApiPrefix);
  app.enableCors();
  await app.listen(config.get<number>('PORT', 3000));
}
void bootstrap();
