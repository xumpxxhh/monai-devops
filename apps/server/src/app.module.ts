import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { assertDatabaseUrl } from './common/storage/assert-database-url.js';
import { EngineModule } from './engine/engine.module.js';
import { HealthModule } from './health/health.module.js';
import { PluginsModule } from './plugins/plugins.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ResourcesModule } from './resources/resources.module.js';
import { StatsModule } from './stats/stats.module.js';
import { SystemModule } from './system/system.module.js';
import { TestDevopsModule } from './test-devops/test-devops.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';

assertDatabaseUrl();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    WorkspaceModule,
    EngineModule,
    WorkflowsModule,
    PluginsModule,
    ResourcesModule,
    StatsModule,
    HealthModule,
    SystemModule,
    TestDevopsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
