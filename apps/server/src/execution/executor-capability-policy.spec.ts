import {
  authorizeExecutorCapabilities,
  ExecutorCapabilityDeniedError,
} from './executor-capability-policy.js';

const plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  capabilities: ['execution.wait', 'network.http'],
};
const step = { id: 'step', name: 'Step', plugin: 'test-plugin', config: {} };

describe('executor capability authorization', () => {
  it('grants only explicitly requested, declared and environmentally allowed capabilities', () => {
    expect(authorizeExecutorCapabilities(plugin, step, '')).toEqual([]);
    expect(
      authorizeExecutorCapabilities(
        plugin,
        {
          ...step,
          mayWait: true,
          requestedCapabilities: ['network.http'],
        },
        'network.http,execution.wait',
      ),
    ).toEqual(['execution.wait', 'network.http']);
  });

  it('fails closed when the plugin declaration or environment policy does not grant a request', () => {
    expect(() =>
      authorizeExecutorCapabilities(
        plugin,
        {
          ...step,
          requestedCapabilities: ['filesystem.write'],
        },
        'filesystem.write',
      ),
    ).toThrow(ExecutorCapabilityDeniedError);
    expect(() =>
      authorizeExecutorCapabilities(
        plugin,
        {
          ...step,
          mayWait: true,
        },
        '',
      ),
    ).toThrow('execution.wait (environment)');
  });

  it('implicitly requires secret.read for any Secret reference', () => {
    const secretStep = { ...step, secretRefs: { apiKey: 'secret://env/API_KEY' } };
    expect(() => authorizeExecutorCapabilities(plugin, secretStep, 'secret.read')).toThrow(
      'secret.read (plugin)',
    );
    expect(
      authorizeExecutorCapabilities(
        { ...plugin, capabilities: [...plugin.capabilities, 'secret.read'] },
        secretStep,
        'secret.read',
      ),
    ).toEqual(['secret.read']);
  });
});
