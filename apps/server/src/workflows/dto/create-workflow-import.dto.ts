import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { WorkflowImportMode } from '../workflows.repository.js';

export class CreateWorkflowImportDto {
  @IsString()
  @MinLength(1)
  childWorkflowId!: string;

  @IsIn(['reference', 'copy'])
  mode!: WorkflowImportMode;

  @IsOptional()
  @IsString()
  stepId?: string;
}
