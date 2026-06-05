import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TestDevopsModule } from './test-devops/test-devops.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    TestDevopsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
