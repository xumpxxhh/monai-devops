import type { SerializedWorkflowLifecycleEvent } from '../common/serialization/serialize-workflow-event.js';
import {
  canMergeStreamLogs,
  mergeStreamLogInto,
} from '../common/serialization/merge-stream-log-event.js';

/** 缓冲超限时优先保留的生命周期事件 */
const LIFECYCLE_EVENT_TYPES = new Set([
  'workflow:start',
  'workflow:finished',
  'workflow:cancelled',
  'workflow:paused',
  'workflow:resumed',
  'workflow:iteration:start',
  'workflow:iteration:finished',
  'step:queued',
  'step:start',
  'step:finished',
]);

/** 超限时优先裁剪 plugin:log，尽量保留生命周期事件 */
export function trimRunEvents(events: SerializedWorkflowLifecycleEvent[], limit: number): void {
  while (events.length > limit) {
    const logIndex = events.findIndex((event) => event.type === 'plugin:log');
    if (logIndex >= 0) {
      events.splice(logIndex, 1);
      continue;
    }

    const disposableIndex = events.findIndex(
      (event) => !LIFECYCLE_EVENT_TYPES.has(String(event.type)),
    );
    if (disposableIndex >= 0) {
      events.splice(disposableIndex, 1);
      continue;
    }

    events.shift();
  }
}

export interface AppendRunEventResult {
  action: 'merge' | 'push';
  mergedTarget?: SerializedWorkflowLifecycleEvent;
}

/**
 * 对事件数组应用追加逻辑（合并连续 stream log + 超限裁剪）。
 * 返回应对 last 合并还是 push 新事件的指示；merge 时会原地修改 last。
 */
export function applyAppendRunEvent(
  events: SerializedWorkflowLifecycleEvent[],
  incoming: SerializedWorkflowLifecycleEvent,
  limit: number,
): AppendRunEventResult {
  const last = events.length > 0 ? events[events.length - 1] : undefined;

  if (last && canMergeStreamLogs(last, incoming)) {
    mergeStreamLogInto(last, incoming);
    if (events.length > limit) {
      trimRunEvents(events, limit);
    }
    return { action: 'merge', mergedTarget: last };
  }

  events.push(incoming);
  if (events.length > limit) {
    trimRunEvents(events, limit);
  }
  return { action: 'push' };
}

export function eventPayloadEquals(
  a: SerializedWorkflowLifecycleEvent,
  b: SerializedWorkflowLifecycleEvent,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 给定完整事件行与裁剪上限，返回应从 DB 删除的行 id 列表。
 * 假定 rows 已按 eventIndex 升序排列。
 */
export function getRunEventRowIdsToDelete<T extends { id: bigint; payload: unknown }>(
  rows: T[],
  limit: number,
): bigint[] {
  if (rows.length <= limit) return [];

  const payloads = rows.map(
    (row) => structuredClone(row.payload) as SerializedWorkflowLifecycleEvent,
  );
  trimRunEvents(payloads, limit);

  const deleteIds: bigint[] = [];
  let survivorIdx = 0;

  for (const row of rows) {
    if (
      survivorIdx < payloads.length &&
      eventPayloadEquals(row.payload as SerializedWorkflowLifecycleEvent, payloads[survivorIdx]!)
    ) {
      survivorIdx += 1;
    } else {
      deleteIds.push(row.id);
    }
  }

  return deleteIds;
}
