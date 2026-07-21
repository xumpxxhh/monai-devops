import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { WorkflowDraftDto } from '../../workflows/dto/workflow-draft.dto.js';

export class SubmitRunDto {
  @ValidateNested()
  @Type(() => WorkflowDraftDto)
  workflow!: WorkflowDraftDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsString()
  traceId?: string;

  @IsOptional()
  @IsBoolean()
  failFast?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxParallelSteps?: number;
}
