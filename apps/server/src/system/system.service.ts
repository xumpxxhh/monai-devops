import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_ENV_LABELS, resolveAppEnv } from './app-env.js';

@Injectable()
export class SystemService {
  constructor(private readonly config: ConfigService) {}

  getInfo() {
    const appEnv = resolveAppEnv(this.config.get<string>('APP_ENV'));
    return {
      appEnv,
      appEnvLabel: APP_ENV_LABELS[appEnv],
    };
  }
}
