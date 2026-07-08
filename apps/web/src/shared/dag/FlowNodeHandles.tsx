import { Handle } from '@xyflow/react';
import { HANDLE_POSITIONS } from './flow-layout';

/** 四向 source + target 锚点，id 与 assignEdgeHandles 使用的 Position 值一致 */
export function FlowNodeHandles({ className }: { className?: string }) {
  return (
    <>
      {HANDLE_POSITIONS.map((position) => (
        <Handle
          key={`target-${position}`}
          type="target"
          position={position}
          id={position}
          className={className}
        />
      ))}
      {HANDLE_POSITIONS.map((position) => (
        <Handle
          key={`source-${position}`}
          type="source"
          position={position}
          id={position}
          className={className}
        />
      ))}
    </>
  );
}
