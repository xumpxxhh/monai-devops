import type { WebSocket } from 'ws';
import { RunStreamService } from './run-stream.service.js';

describe('RunStreamService offset replay', () => {
  it('replays by persisted offset instead of array position', () => {
    const service = new RunStreamService();
    const sent: string[] = [];
    const client = {
      OPEN: 1,
      readyState: 1,
      send: (message: string) => sent.push(message),
    } as unknown as WebSocket;

    service.subscribe(
      'run-1',
      client,
      [
        { type: 'workflow:start', offset: 0 },
        { type: 'step:start', offset: 4 },
        { type: 'step:finished', offset: 7 },
      ],
      4,
    );

    expect(sent.map((message) => JSON.parse(message).event.offset)).toEqual([4, 7]);
  });

  it('falls back to array position for legacy events without offsets', () => {
    const service = new RunStreamService();
    const sent: string[] = [];
    const client = {
      OPEN: 1,
      readyState: 1,
      send: (message: string) => sent.push(message),
    } as unknown as WebSocket;

    service.subscribe(
      'run-legacy',
      client,
      [{ type: 'workflow:start' }, { type: 'workflow:finished' }],
      1,
    );

    expect(sent.map((message) => JSON.parse(message).event.type)).toEqual(['workflow:finished']);
  });
});
