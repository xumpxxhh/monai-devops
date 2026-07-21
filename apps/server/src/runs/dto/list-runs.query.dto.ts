import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import type { RunStatus } from '../runs.repository.js';

const RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'pausing',
  'finished',
  'failed',
  'rejected',
  'cancelled',
] as const satisfies readonly RunStatus[];

export class ListRunsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(RUN_STATUSES)
  status?: RunStatus;

  @IsOptional()
  @IsString()
  workflowId?: string;
}
