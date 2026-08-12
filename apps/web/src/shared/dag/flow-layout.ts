import dagre from '@dagrejs/dagre';
import { MarkerType, Position, type Edge, type Node } from '@xyflow/react';

export const HANDLE_POSITIONS = [
  Position.Top,
  Position.Right,
  Position.Bottom,
  Position.Left,
] as const;

export type LayoutDirection = 'LR' | 'TB';

/** 节点未渲染时用于估算布局的默认尺寸，实际渲染后会用 node.measured 覆盖 */
export const LAYOUT_NODE_WIDTH = 160;
export const LAYOUT_NODE_HEIGHT = 92;

export const directedEdgeOptions = {
  type: 'smoothstep' as const,
  pathOptions: { borderRadius: 8, offset: 16 },
  markerEnd: {
    type: MarkerType.Arrow,
    width: 16,
    height: 16,
    color: 'var(--faint)',
  },
  style: { stroke: 'var(--faint)', strokeWidth: 1.5 },
};

/** 基于 dagre 的分层算法，按依赖方向自动排布节点，避免手工网格布局导致的连线交叉 */
export function getLayoutedNodes<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
  direction: LayoutDirection = 'LR',
): Node<T>[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep: 40, ranksep: 80 });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.measured?.width ?? LAYOUT_NODE_WIDTH,
      height: node.measured?.height ?? LAYOUT_NODE_HEIGHT,
    });
  }
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const layout = graph.node(node.id);
    if (!layout) return node;
    const width = node.measured?.width ?? LAYOUT_NODE_WIDTH;
    const height = node.measured?.height ?? LAYOUT_NODE_HEIGHT;
    return {
      ...node,
      position: { x: layout.x - width / 2, y: layout.y - height / 2 },
    };
  });
}

export function getNodeCenter(node: Node): { x: number; y: number } {
  return {
    x: node.position.x + (node.measured?.width ?? LAYOUT_NODE_WIDTH) / 2,
    y: node.position.y + (node.measured?.height ?? LAYOUT_NODE_HEIGHT) / 2,
  };
}

/**
 * 节点固定只有上下左右四个锚点，边必须显式指定 sourceHandle/targetHandle 才能正确锚定
 * （否则 React Flow 无法从多个同类型锚点中确定应使用哪一个）。
 * 这里按两节点中心点的主方向选出最自然的一对锚点。
 */
export function pickHandlePair(
  source: Node,
  target: Node,
): { sourceHandle: Position; targetHandle: Position } {
  const a = getNodeCenter(source);
  const b = getNodeCenter(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: Position.Right, targetHandle: Position.Left }
      : { sourceHandle: Position.Left, targetHandle: Position.Right };
  }
  return dy >= 0
    ? { sourceHandle: Position.Bottom, targetHandle: Position.Top }
    : { sourceHandle: Position.Top, targetHandle: Position.Bottom };
}

/** 基于节点最终位置，为程序化生成的边（非用户手动拖拽连线）重新分配 sourceHandle/targetHandle */
export function assignEdgeHandles(nodes: Node[], edges: Edge[]): Edge[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return edges.map((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return edge;
    const { sourceHandle, targetHandle } = pickHandlePair(source, target);
    return { ...edge, sourceHandle, targetHandle };
  });
}
