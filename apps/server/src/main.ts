import './preload-env.js';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
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
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
}
void bootstrap();
