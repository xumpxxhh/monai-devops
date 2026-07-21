import { IsObject, IsOptional } from 'class-validator';

export class PluginDryRunDto {
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
