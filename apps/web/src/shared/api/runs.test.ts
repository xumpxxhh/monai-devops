import { afterEach, expect, it, vi } from 'vitest';
import { runsApi } from './runs';

afterEach(() => vi.unstubAllGlobals());

it('encodes composite Attempt IDs before sending a wake signal', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ runId: 'run-1', attemptId: 'run-1/step-1/attempt-0', accepted: true }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );
  vi.stubGlobal('fetch', fetch);

  await runsApi.signalWait('run-1', 'run-1/step-1/attempt-0', 'approved', { approved: true });

  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/runs/run-1/attempts/run-1%2Fstep-1%2Fattempt-0/signal'),
    expect.objectContaining({ method: 'POST' }),
  );
});
