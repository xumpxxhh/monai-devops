import type { WsConnectionStatus } from '../api/workflow-run-client';

const WS_LABELS: Record<WsConnectionStatus, { label: string; dot: string; text: string }> = {
  connected: { label: '已连接 ws', dot: 'bg-completed live-dot', text: 'text-completed' },
  connecting: { label: '连接中…', dot: 'bg-queued live-dot', text: 'text-queued' },
  disconnected: { label: '未连接', dot: 'bg-faint', text: 'text-muted' },
  error: { label: '连接断开', dot: 'bg-failed', text: 'text-failed' },
};

interface WsPillProps {
  status: WsConnectionStatus;
}

export function WsPill({ status }: WsPillProps) {
  const s = WS_LABELS[status];
  return (
    <span className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-pill bg-raised border border-line">
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      <span className={`font-medium ${s.text}`}>{s.label}</span>
    </span>
  );
}
