import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  WorkflowDraft,
  WorkflowDraftStep,
} from '../../common/validation/normalize-workflow-ids.js';

export class WorkflowRefDto {
  @IsString()
  @MinLength(1)
  importId!: string;
}

export class WorkflowLoopUntilDto {
  @IsString()
  @MinLength(1)
  when!: string;

  @IsOptional()
  equals?: unknown;

  @IsOptional()
  exists?: boolean;
}

export class WorkflowLoopDto {
  @IsNumber()
  @Min(1)
  maxIterations!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowLoopUntilDto)
  until?: WorkflowLoopUntilDto;
}

export class WorkflowDraftStepDto implements WorkflowDraftStep {
  @IsOptional()
  @IsString()
  clientRef?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsIn(['plugin', 'workflow', 'set_state'])
  kind?: 'plugin' | 'workflow' | 'set_state';

  @IsOptional()
  @IsString()
  @MinLength(1)
  plugin?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  patch?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowRefDto)
  workflowRef?: WorkflowRefDto;

  @IsOptional()
  inputState?: unknown;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkflowLoopDto)
  loop?: WorkflowLoopDto;

  @IsOptional()
  condition?: WorkflowDraftStep['condition'];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependsOn?: string[];

  @IsOptional()
  @IsNumber()
  priority?: number;
}

export class WorkflowDraftDto implements WorkflowDraft {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsObject()
  stateSchema?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowDraftStepDto)
  steps!: WorkflowDraftStepDto[];
}
