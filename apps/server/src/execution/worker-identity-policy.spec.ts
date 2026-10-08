import {
  authenticateWorker,
  parseWorkerIdentities,
  workerOffersAllowed,
} from './worker-identity-policy.js';

describe('worker identity policy', () => {
  const current = 'current-token-with-more-than-thirty-two-characters';
  const previous = 'previous-token-with-more-than-thirty-two-characters';
  const offer = { name: 'test-plugin', version: '1.0.0', capabilities: ['execution.wait'] };
  const json = JSON.stringify([
    { workerId: 'worker-a', tokens: [current, previous], plugins: [offer] },
  ]);

  it('binds both rotation credentials to one worker and restricts claimed capabilities', () => {
    const [identity] = parseWorkerIdentities(json);
    expect(authenticateWorker(current, [identity])).toBe(identity);
    expect(authenticateWorker(previous, [identity])).toBe(identity);
    expect(authenticateWorker('invalid', [identity])).toBeUndefined();
    expect(workerOffersAllowed([offer], identity)).toBe(true);
    expect(workerOffersAllowed([{ ...offer, capabilities: ['network'] }], identity)).toBe(false);
    expect(workerOffersAllowed([{ ...offer, version: '2.0.0' }], identity)).toBe(false);
  });

  it('rejects duplicate credentials and weak credentials', () => {
    expect(() =>
      parseWorkerIdentities(
        JSON.stringify([{ workerId: 'a', tokens: [current, current], plugins: [offer] }]),
      ),
    ).toThrow();
    expect(() =>
      parseWorkerIdentities(
        JSON.stringify([{ workerId: 'a', tokens: ['short'], plugins: [offer] }]),
      ),
    ).toThrow();
  });
});
