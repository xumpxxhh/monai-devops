import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  WorkflowDraft,
  WorkflowDraftStep,
} from '../../common/validation/normalize-workflow-ids.js';

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

  @IsString()
  @MinLength(1)
  plugin!: string;

  @IsObject()
  config!: Record<string, unknown>;

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

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowDraftStepDto)
  steps!: WorkflowDraftStepDto[];
}
