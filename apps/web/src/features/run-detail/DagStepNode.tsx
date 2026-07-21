import { type Node, type NodeProps } from '@xyflow/react';
import { FlowNodeHandles } from '../../shared/dag/FlowNodeHandles';
import { StatusBadge } from '../../shared/status/StatusBadge';
import type { DagStepNodeData } from './run-state';

export function DagStepNode({ data }: NodeProps<Node<DagStepNodeData>>) {
  const ringClass = `node-${data.status}`;
  const isRunning = data.status === 'running';
  const handleClass = '!w-1.5 !h-1.5 !bg-transparent !border-transparent !opacity-0 !z-10';

  return (
    <div
      className={`px-4 py-3 rounded-ctrl bg-surface border border-line min-w-[120px] text-left ${ringClass} ${isRunning ? 'running-ring' : ''}`}
    >
      <FlowNodeHandles className={handleClass} />
      <div className="text-sm font-medium truncate">{data.label}</div>
      <div className="text-xs text-faint font-mono truncate">{data.plugin}</div>
      <StatusBadge status={data.status} />
    </div>
  );
}
