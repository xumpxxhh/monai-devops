import { type Node, type NodeProps } from '@xyflow/react';
import { StepKinds } from '@monai-devops/core-engine';
import { FlowNodeHandles } from '../../shared/dag/FlowNodeHandles';
import { StatusBadge } from '../../shared/status/StatusBadge';
import type { DagStepNodeData } from './run-state';

export function DagStepNode({ data }: NodeProps<Node<DagStepNodeData>>) {
  const ringClass = `node-${data.status}`;
  const isRunning = data.status === 'running';
  const handleClass = '!w-1.5 !h-1.5 !bg-transparent !border-transparent !opacity-0 !z-10';
  const isWorkflow = data.kind === StepKinds.WORKFLOW;
  const isSetState = data.kind === StepKinds.SET_STATE;

  return (
    <div
      className={`px-4 py-3 rounded-ctrl bg-surface border min-w-[120px] text-left relative ${ringClass} ${isRunning ? 'running-ring' : ''} ${
        isWorkflow
          ? 'border-brand/40 border-dashed'
          : isSetState
            ? 'border-warning/40'
            : 'border-line'
      }`}
    >
      <FlowNodeHandles className={handleClass} />
      {isWorkflow && (
        <span className="absolute -top-1.5 -right-1.5 text-[9px] px-1 rounded bg-brand text-white">
          子
        </span>
      )}
      <div className="text-sm font-medium truncate">{data.label}</div>
      <div className="text-xs text-faint font-mono truncate">{data.plugin}</div>
      <StatusBadge status={data.status} />
    </div>
  );
}
