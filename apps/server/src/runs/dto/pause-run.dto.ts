import { IsBoolean, IsOptional } from 'class-validator';

export class PauseRunDto {
  @IsOptional()
  @IsBoolean()
  waitInFlight?: boolean;

  @IsOptional()
  @IsBoolean()
  abortInFlight?: boolean;
}
