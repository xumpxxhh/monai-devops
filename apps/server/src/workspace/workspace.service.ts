import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly root: string;

  constructor(private readonly config: ConfigService) {
    const configured = this.config.get<string>('CI_WORKSPACE_ROOT')?.trim();
    this.root = configured ? resolve(configured) : resolve(tmpdir(), 'monai-ci-runs');
  }

  getRoot(): string {
    return this.root;
  }

  resolveWorkspacePath(runId: string): string {
    const id = runId.trim();
    if (!SAFE_RUN_ID.test(id)) {
      throw new Error(`Invalid runId for workspace path: ${runId}`);
    }
    return join(this.root, id);
  }

  async createWorkspace(runId: string): Promise<string> {
    const dir = this.resolveWorkspacePath(runId);
    await mkdir(dir, { recursive: true });
    this.logger.debug(`Workspace created: ${dir}`);
    return dir;
  }

  async cleanupWorkspace(runId: string): Promise<void> {
    const dir = this.resolveWorkspacePath(runId);
    try {
      await rm(dir, { recursive: true, force: true });
      this.logger.debug(`Workspace cleaned: ${dir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to cleanup workspace ${dir}: ${message}`);
    }
  }
}
