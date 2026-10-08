import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { developmentWorkflows } from './development-workflows.js';
import { WorkflowsService } from './workflows.service.js';
import { WORKFLOW_REPOSITORY, type WorkflowRepository } from './workflows.repository.js';

@Injectable()
export class DevelopmentWorkflowSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(DevelopmentWorkflowSeeder.name);

  constructor(
    private readonly config: ConfigService,
    private readonly workflows: WorkflowsService,
    @Inject(WORKFLOW_REPOSITORY) private readonly repository: WorkflowRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const environment = this.config.get<string>('APP_ENV');
    const enabled = this.config.get<string | boolean>('DEV_WORKFLOW_SEED_ENABLED');
    if (
      !['local-dev', 'online-dev'].includes(environment ?? '') ||
      process.env.NODE_ENV === 'production' ||
      enabled === false ||
      enabled === 'false'
    ) {
      return;
    }

    for (const definition of developmentWorkflows) {
      if (await this.repository.findById(definition.id)) continue;
      if (await this.repository.findByName(definition.name)) {
        this.logger.warn(`Development workflow name already used: ${definition.name}`);
        continue;
      }
      try {
        await this.workflows.create(definition);
        this.logger.log(`Seeded development workflow: ${definition.id}`);
      } catch (error) {
        if (
          error instanceof HttpException &&
          error.getStatus() === HttpStatus.CONFLICT &&
          (await this.repository.findById(definition.id))
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}
