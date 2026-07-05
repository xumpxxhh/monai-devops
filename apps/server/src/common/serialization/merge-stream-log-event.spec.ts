import type { SerializedWorkflowLifecycleEvent } from './serialize-workflow-event.js';
import {
  canMergeStreamLogs,
  isStreamPluginLog,
  mergeStreamLogInto,
} from './merge-stream-log-event.js';

function streamLog(
  stepId: string,
  message: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  timestamp = 1,
): SerializedWorkflowLifecycleEvent {
  return {
    type: 'plugin:log',
    meta: { runId: 'run-1', workflowId: 'wf-1' },
    step: { id: stepId, name: stepId, plugin: 'test-plugin' },
    log: { level: 'info', message, timestamp, stream },
  };
}

describe('merge-stream-log-event', () => {
  describe('isStreamPluginLog', () => {
    it('returns true for plugin:log with stdout or stderr', () => {
      expect(isStreamPluginLog(streamLog('s1', 'a'))).toBe(true);
      expect(isStreamPluginLog(streamLog('s1', 'a', 'stderr'))).toBe(true);
    });

    it('returns false for non-stream plugin:log and lifecycle events', () => {
      expect(
        isStreamPluginLog({
          type: 'plugin:log',
          log: { level: 'info', message: 'hello', timestamp: 1 },
        }),
      ).toBe(false);
      expect(isStreamPluginLog({ type: 'step:start' })).toBe(false);
    });
  });

  describe('canMergeStreamLogs', () => {
    it('merges adjacent same step and same stream logs', () => {
      const last = streamLog('s1', 'line1\n');
      const incoming = streamLog('s1', 'line2\n', 'stdout', 2);
      expect(canMergeStreamLogs(last, incoming)).toBe(true);
    });

    it('does not merge when stream differs', () => {
      const last = streamLog('s1', 'err', 'stderr');
      const incoming = streamLog('s1', 'out', 'stdout', 2);
      expect(canMergeStreamLogs(last, incoming)).toBe(false);
    });

    it('does not merge when step differs', () => {
      const last = streamLog('s1', 'a');
      const incoming = streamLog('s2', 'b', 'stdout', 2);
      expect(canMergeStreamLogs(last, incoming)).toBe(false);
    });

    it('does not merge plain plugin:log without stream', () => {
      const last = {
        type: 'plugin:log',
        log: { level: 'info', message: 'hello', timestamp: 1 },
      };
      const incoming = streamLog('s1', 'line');
      expect(canMergeStreamLogs(last, incoming)).toBe(false);
    });

    it('does not merge after lifecycle event', () => {
      const last = { type: 'step:finished' };
      const incoming = streamLog('s1', 'line');
      expect(canMergeStreamLogs(last, incoming)).toBe(false);
    });
  });

  describe('mergeStreamLogInto', () => {
    it('concatenates message and updates timestamp', () => {
      const target = streamLog('s1', 'line1\n', 'stdout', 1);
      const incoming = streamLog('s1', 'line2\n', 'stdout', 99);
      mergeStreamLogInto(target, incoming);
      expect((target.log as { message: string }).message).toBe('line1\nline2\n');
      expect((target.log as { timestamp: number }).timestamp).toBe(99);
    });
  });
});
