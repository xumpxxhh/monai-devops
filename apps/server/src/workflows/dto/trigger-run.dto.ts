import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class TriggerRunDto {
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
