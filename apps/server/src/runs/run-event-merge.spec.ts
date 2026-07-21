import type { SerializedWorkflowLifecycleEvent } from '../common/serialization/serialize-workflow-event.js';
import {
  applyAppendRunEvent,
  getRunEventRowIdsToDelete,
  trimRunEvents,
} from './run-event-merge.js';

function streamLog(
  stepId: string,
  message: string,
  stream: 'stdout' | 'stderr' = 'stdout',
): SerializedWorkflowLifecycleEvent {
  return {
    type: 'plugin:log',
    workflowRunId: 'run-1',
    meta: { workflowId: 'wf-1' },
    step: { id: stepId, name: stepId, plugin: 'test-plugin' },
    log: { level: 'info', message, timestamp: Date.now(), stream },
  };
}

function lifecycleEvent(type: string): SerializedWorkflowLifecycleEvent {
  return {
    type,
    workflowRunId: 'run-1',
    meta: { workflowId: 'wf-1' },
    step: { id: 's1', name: 'S1', plugin: 'test-plugin' },
  };
}

describe('run-event-merge', () => {
  describe('trimRunEvents', () => {
    it('removes one plugin:log when trimming to limit', () => {
      const events = [
        lifecycleEvent('workflow:start'),
        streamLog('s1', 'log1'),
        streamLog('s1', 'log2'),
        lifecycleEvent('step:finished'),
      ];
      trimRunEvents(events, 3);
      expect(events).toHaveLength(3);
      expect(events.filter((event) => event.type === 'plugin:log')).toHaveLength(1);
      expect(events[0]?.type).toBe('workflow:start');
      expect(events[events.length - 1]?.type).toBe('step:finished');
    });

    it('removes non-lifecycle events before lifecycle events', () => {
      const events = [
        lifecycleEvent('workflow:start'),
        { type: 'custom:debug', workflowRunId: 'run-1' },
        lifecycleEvent('step:finished'),
      ];
      trimRunEvents(events, 2);
      expect(events).toHaveLength(2);
      expect(events.some((event) => event.type === 'custom:debug')).toBe(false);
    });
  });

  describe('applyAppendRunEvent', () => {
    it('merges consecutive stream logs', () => {
      const events: SerializedWorkflowLifecycleEvent[] = [];
      applyAppendRunEvent(events, streamLog('s1', 'line1\n'), 10);
      applyAppendRunEvent(events, streamLog('s1', 'line2\n'), 10);

      expect(events).toHaveLength(1);
      expect((events[0]?.log as { message: string }).message).toBe('line1\nline2\n');
    });

    it('trims after push when over limit', () => {
      const events: SerializedWorkflowLifecycleEvent[] = [];
      for (let i = 0; i < 5; i += 1) {
        applyAppendRunEvent(events, lifecycleEvent(`step:${i}`), 3);
      }
      expect(events).toHaveLength(3);
      expect(events[0]?.type).toBe('step:2');
    });
  });

  describe('getRunEventRowIdsToDelete', () => {
    it('returns ids for rows removed by trim logic', () => {
      const rows = [
        { id: 1n, payload: streamLog('s1', 'a') },
        { id: 2n, payload: streamLog('s1', 'b') },
        { id: 3n, payload: lifecycleEvent('workflow:start') },
        { id: 4n, payload: lifecycleEvent('step:finished') },
      ];
      const deleteIds = getRunEventRowIdsToDelete(rows, 2);
      expect(deleteIds).toEqual([1n, 2n]);
    });
  });
});
