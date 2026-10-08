import { jest } from '@jest/globals';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { validateWorkflowDefinition } from '../common/validation/validate-workflow.js';
import { registeredPlugins } from '../plugins/plugin-registry.js';
import { DevelopmentWorkflowSeeder } from './development-workflow-seeder.js';
import { developmentWorkflows } from './development-workflows.js';
import type { WorkflowRepository } from './workflows.repository.js';
import type { WorkflowsService } from './workflows.service.js';

describe('development workflow seed', () => {
  it('ships distinct valid workflows with valid registered plugin configurations', async () => {
    expect(new Set(developmentWorkflows.map((workflow) => workflow.id)).size).toBe(
      developmentWorkflows.length,
    );
    expect(new Set(developmentWorkflows.map((workflow) => workflow.name)).size).toBe(
      developmentWorkflows.length,
    );
    for (const workflow of developmentWorkflows) {
      await expect(validateWorkflowDefinition(workflow)).resolves.toBeUndefined();
      for (const step of workflow.steps) {
        if (!('plugin' in step)) continue;
        const plugin = registeredPlugins.find((candidate) => candidate.name === step.plugin);
        expect(plugin).toBeDefined();
        expect(plugin!.configSchema?.safeParse(step.config).success).toBe(true);
      }
    }
  });

  it('creates missing defaults once without replacing edited workflows', async () => {
    const existing = new Set<string>();
    const create = jest.fn(async (workflow: (typeof developmentWorkflows)[number]) => {
      existing.add(workflow.id);
      return undefined;
    });
    const repository = {
      findById: jest.fn(async (id: string) => (existing.has(id) ? { id } : undefined)),
      findByName: jest.fn(async () => undefined),
    } as unknown as WorkflowRepository;
    const config = {
      get: (key: string) => (key === 'APP_ENV' ? 'local-dev' : undefined),
    } as ConfigService;
    const seeder = new DevelopmentWorkflowSeeder(
      config,
      { create } as unknown as WorkflowsService,
      repository,
    );
    await seeder.onApplicationBootstrap();
    await seeder.onApplicationBootstrap();
    expect(create).toHaveBeenCalledTimes(developmentWorkflows.length);
  });

  it.each(['local-test', 'production'])('does not seed in %s', async (environment) => {
    const create = jest.fn(async () => undefined);
    const seeder = new DevelopmentWorkflowSeeder(
      { get: (key: string) => (key === 'APP_ENV' ? environment : undefined) } as ConfigService,
      { create } as unknown as WorkflowsService,
      {} as WorkflowRepository,
    );
    await seeder.onApplicationBootstrap();
    expect(create).not.toHaveBeenCalled();
  });

  it('tolerates another development server creating the same ID concurrently', async () => {
    const existing = new Set<string>();
    const create = jest.fn(async (workflow: (typeof developmentWorkflows)[number]) => {
      existing.add(workflow.id);
      throw new HttpException('already created', HttpStatus.CONFLICT);
    });
    const repository = {
      findById: jest.fn(async (id: string) => (existing.has(id) ? { id } : undefined)),
      findByName: jest.fn(async () => undefined),
    } as unknown as WorkflowRepository;
    const seeder = new DevelopmentWorkflowSeeder(
      { get: (key: string) => (key === 'APP_ENV' ? 'online-dev' : undefined) } as ConfigService,
      { create } as unknown as WorkflowsService,
      repository,
    );
    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(developmentWorkflows.length);
  });
});
