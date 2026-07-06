export type StepUiStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export const STATUS_META: Record<StepUiStatus, { label: string; color: string; icon: string }> = {
  idle: { label: '待执行', color: 'text-faint', icon: 'circle' },
  queued: { label: '排队中', color: 'text-queued', icon: 'clock' },
  running: { label: '运行中', color: 'text-running', icon: 'spinner' },
  completed: { label: '已完成', color: 'text-completed', icon: 'check' },
  failed: { label: '失败', color: 'text-failed', icon: 'xmark' },
  skipped: { label: '已跳过', color: 'text-skipped', icon: 'forward' },
};

export const RUN_STATUS_META: Record<string, { label: string; color: string; dot: string }> = {
  queued: { label: '排队', color: 'text-queued', dot: 'bg-queued' },
  running: { label: '运行中', color: 'text-running', dot: 'bg-running live-dot' },
  pausing: { label: '暂停中', color: 'text-queued', dot: 'bg-queued live-dot' },
  paused: { label: '已暂停', color: 'text-queued', dot: 'bg-queued' },
  finished: { label: '已完成', color: 'text-completed', dot: 'bg-completed' },
  failed: { label: '失败', color: 'text-failed', dot: 'bg-failed' },
  rejected: { label: '已拒绝', color: 'text-failed', dot: 'bg-failed' },
  cancelled: { label: '已取消', color: 'text-skipped', dot: 'bg-skipped' },
};
