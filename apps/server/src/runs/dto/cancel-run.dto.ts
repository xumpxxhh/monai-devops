import { IsIn, IsOptional } from 'class-validator';

export class CancelRunDto {
  @IsOptional()
  @IsIn(['best-effort', 'hard'])
  mode?: 'best-effort' | 'hard';
}
