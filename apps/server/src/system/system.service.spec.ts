import { ConfigService } from '@nestjs/config';
import { SystemService } from './system.service.js';

describe('SystemService', () => {
  function createService(appEnv: string | undefined) {
    const config = {
      get: (key: string) => (key === 'APP_ENV' ? appEnv : undefined),
    } as ConfigService;
    return new SystemService(config);
  }

  it('defaults to local-dev when APP_ENV is missing', () => {
    expect(createService(undefined).getInfo()).toEqual({
      appEnv: 'local-dev',
      appEnvLabel: '本地开发',
    });
  });

  it('defaults to local-dev when APP_ENV is blank', () => {
    expect(createService('  ').getInfo()).toEqual({
      appEnv: 'local-dev',
      appEnvLabel: '本地开发',
    });
  });

  it('returns label for a valid APP_ENV', () => {
    expect(createService('production').getInfo()).toEqual({
      appEnv: 'production',
      appEnvLabel: '生产',
    });
  });

  it('throws when APP_ENV is invalid', () => {
    expect(() => createService('staging').getInfo()).toThrow(/APP_ENV must be one of/);
  });
});
