import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { EngineModule } from './engine/engine.module.js';
import { HealthModule } from './health/health.module.js';
import { PluginsModule } from './plugins/plugins.module.js';
import { ResourcesModule } from './resources/resources.module.js';
import { RunsModule } from './runs/runs.module.js';
import { StatsModule } from './stats/stats.module.js';
import { TestDevopsModule } from './test-devops/test-devops.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    EngineModule,
    WorkflowsModule,
    PluginsModule,
    ResourcesModule,
    StatsModule,
    HealthModule,
    TestDevopsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
