import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function resolvePagination(
  query: Pick<PaginationQueryDto, 'page' | 'pageSize'>,
  defaults = { page: 1, pageSize: 20 },
) {
  const page = Math.max(1, query.page ?? defaults.page);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? defaults.pageSize));
  return { page, pageSize };
}
