import { Global, Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';

@Global()
@Module({
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
