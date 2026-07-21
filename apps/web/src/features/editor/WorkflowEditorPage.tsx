import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Node,
  type NodeProps,
  type Edge,
  ConnectionLineType,
  ConnectionMode,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { extractContextReferences, type WorkflowDefinition } from '@monai-devops/core-engine';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCog,
  faPlay,
  faSave,
  faGripLinesVertical,
  faGripLines,
} from '@fortawesome/free-solid-svg-icons';
import { workflowsApi, type WorkflowDraft } from '../../shared/api/workflows';
import { runsApi } from '../../shared/api/runs';
import { ApiError } from '../../shared/api/http';
import { pluginsApi } from '../../shared/api/misc';
import type { PluginInfo } from '../../shared/types';
import { getAncestorIds, validateDag } from './dag-utils';
import {
  formatStepConfigIssues,
  validateAllStepConfigs,
  validateStepConfig,
} from './step-config-validation';
import { FullscreenLayout } from '../../layouts/FullscreenLayout';
import { Field, Input, Select, Checkbox } from '../../shared/ui/form';
import { PluginConfigFormModal, preloadPluginConfigSchemas } from '../../shared/plugins';
import type {
  ConfigReferenceSource,
  JsonObjectSchema,
} from '../../shared/ui/json-schema-form/types';
import { toast } from 'sonner';
import {
  assignEdgeHandles,
  directedEdgeOptions,
  getLayoutedNodes,
  type LayoutDirection,
} from '../../shared/dag/flow-layout';
import { FlowNodeHandles } from '../../shared/dag/FlowNodeHandles';

interface StepNodeData {
  label: string;
  plugin: string;
  clientRef: string;
  stepId?: string;
  config?: Record<string, unknown>;
  priority?: number;
  configInvalid?: boolean;
  [key: string]: unknown;
}

interface SelectionSnapshot {
  id: string;
  data: StepNodeData;
}

interface EditorStep {
  id: string;
  plugin: string;
  label: string;
  dependsOn: string[];
}

interface TopologySnapshot {
  nodeCount: number;
  errors: string[];
  steps: EditorStep[];
}

export interface WorkflowFlowHandle {
  getNodes: () => Node<StepNodeData>[];
  getEdges: () => Edge[];
  loadDefinition: (definition: WorkflowDefinition) => void;
  addStep: (plugin: string) => void;
  updateNodeData: (
    nodeId: string,
    patch: Partial<Pick<StepNodeData, 'label' | 'plugin' | 'config' | 'priority'>>,
  ) => void;
  selectNode: (nodeId: string) => void;
}

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const handleClass = selected
    ? '!w-2 !h-2 !bg-brand !border-2 !border-white'
    : '!w-1.5 !h-1.5 !bg-line !border !border-white';

  const borderClass = data.configInvalid
    ? 'border-failed bg-failed/5'
    : selected
      ? 'border-brand/50'
      : 'border-line node-idle hover:border-faint/40';

  return (
    <div
      className={`px-2.5 py-1.5 rounded-ctrl min-w-[100px] max-w-[140px] border transition-[border-color,background-color,box-shadow] duration-150 ${
        selected ? 'bg-brand-soft node-selected' : 'bg-surface'
      } ${borderClass}`}
    >
      <FlowNodeHandles className={`${handleClass} !z-10`} />
      <div className={`text-xs font-medium truncate leading-tight ${selected ? 'text-ink' : ''}`}>
        {data.label}
      </div>
      <div
        className={`text-[10px] font-mono truncate leading-tight mt-0.5 ${selected ? 'text-brand' : 'text-faint'}`}
      >
        {data.plugin}
      </div>
    </div>
  );
});

const nodeTypes = { step: StepNode };

function createClientRef() {
  return crypto.randomUUID();
}

function definitionToFlow(definition: WorkflowDefinition): {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<StepNodeData>[] = definition.steps.map((step) => ({
    id: step.id,
    type: 'step',
    position: { x: 0, y: 0 },
    data: {
      label: step.name,
      plugin: step.plugin,
      clientRef: step.id,
      stepId: step.id,
      config: step.config,
      priority: step.priority,
    } satisfies StepNodeData,
  }));
  const edges: Edge[] = [];
  for (const step of definition.steps) {
    for (const dep of step.dependsOn ?? []) {
      edges.push({
        id: `${dep}->${step.id}`,
        source: dep,
        target: step.id,
        ...directedEdgeOptions,
      });
    }
  }
  const layoutedNodes = getLayoutedNodes(nodes, edges, 'LR');
  return { nodes: layoutedNodes, edges: assignEdgeHandles(layoutedNodes, edges) };
}

function resolveNodeRef(node: Node<StepNodeData>): string {
  const data = node.data;
  return data.stepId ?? data.clientRef ?? node.id;
}

function buildDraft(
  nodes: Node<StepNodeData>[],
  edges: Edge[],
  workflowName: string,
  workflowId: string | null,
): WorkflowDraft {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return {
    ...(workflowId ? { id: workflowId } : {}),
    name: workflowName,
    steps: nodes.map((node) => {
      const data = node.data;
      const config = data.config ?? {};

      const deps = edges
        .filter((e) => e.target === node.id)
        .map((e) => {
          const source = nodeById.get(e.source);
          return source ? resolveNodeRef(source) : e.source;
        });

      return {
        clientRef: data.clientRef ?? node.id,
        ...(data.stepId ? { id: data.stepId } : {}),
        name: data.label,
        plugin: data.plugin,
        config,
        dependsOn: deps,
        priority: data.priority,
      };
    }),
  };
}

function validateWorkflowName(name: string): string | undefined {
  if (!name.trim()) {
    return '工作流名称不能为空';
  }
  return undefined;
}

function dagStepsFromNodes(nodes: Node<StepNodeData>[], edges: Edge[]) {
  return nodes.map((node) => ({
    id: node.id,
    dependsOn: edges.filter((e) => e.target === node.id).map((e) => e.source),
  }));
}

/**
 * 拓扑指纹：节点 id / 业务引用 / plugin / label + 边。
 * 刻意忽略 position / selected / dragging，避免拖动时误触发父级更新。
 */
function topologyKey(nodes: Node<StepNodeData>[], edges: Edge[]): string {
  const nodePart = nodes
    .map((n) => `${n.id}\0${resolveNodeRef(n)}\0${n.data.plugin}\0${n.data.label}`)
    .join('\n');
  const edgePart = edges.map((e) => `${e.source}\0${e.target}`).join('\n');
  return `${nodePart}|${edgePart}`;
}

function buildEditorSteps(nodes: Node<StepNodeData>[], edges: Edge[]): EditorStep[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((node) => ({
    id: resolveNodeRef(node),
    plugin: node.data.plugin,
    label: node.data.label,
    dependsOn: edges
      .filter((e) => e.target === node.id)
      .map((e) => {
        const source = nodeById.get(e.source);
        return source ? resolveNodeRef(source) : e.source;
      }),
  }));
}

function selectionSnapshotEqual(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.data === b.data;
}

const WorkflowFlow = forwardRef<
  WorkflowFlowHandle,
  {
    configInvalidNodeIds: Set<string>;
    onSelectionSnapshot: (selection: SelectionSnapshot | null) => void;
    onTopologyChange: (topology: TopologySnapshot) => void;
    onNodeDoubleClick: (node: Node<StepNodeData>) => void;
  }
>(function WorkflowFlow(
  { configInvalidNodeIds, onSelectionSnapshot, onTopologyChange, onNodeDoubleClick },
  ref,
) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const topologyKeyRef = useRef('');

  const publishTopology = useCallback(
    (nextNodes: Node<StepNodeData>[], nextEdges: Edge[]) => {
      const key = topologyKey(nextNodes, nextEdges);
      if (key === topologyKeyRef.current) return;
      topologyKeyRef.current = key;
      const validation = validateDag(dagStepsFromNodes(nextNodes, nextEdges));
      setValidationErrors(validation.errors);
      onTopologyChange({
        nodeCount: nextNodes.length,
        errors: validation.errors,
        steps: buildEditorSteps(nextNodes, nextEdges),
      });
    },
    [onTopologyChange],
  );

  useEffect(() => {
    publishTopology(nodes, edges);
  }, [nodes, edges, publishTopology]);

  // 将 configInvalid 写回节点 data；仅在非法 id 集合变化时执行，避免拖动时改写全部节点引用
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        const configInvalid = configInvalidNodeIds.has(n.id);
        if (n.data.configInvalid === configInvalid) return n;
        changed = true;
        return { ...n, data: { ...n.data, configInvalid } };
      });
      return changed ? next : nds;
    });
  }, [configInvalidNodeIds, setNodes]);

  useImperativeHandle(
    ref,
    () => ({
      getNodes: () => nodes,
      getEdges: () => edges,
      loadDefinition: (definition: WorkflowDefinition) => {
        const flow = definitionToFlow(definition);
        topologyKeyRef.current = '';
        setNodes(flow.nodes);
        setEdges(flow.edges);
        onSelectionSnapshot(null);
        requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
      },
      addStep: (plugin: string) => {
        const clientRef = createClientRef();
        const count = nodes.length;
        const newNode: Node<StepNodeData> = {
          id: clientRef,
          type: 'step',
          position: { x: 120 + count * 40, y: 200 },
          data: {
            label: `步骤 ${count + 1}`,
            plugin,
            clientRef,
            config: {},
          },
        };
        setNodes((nds) => {
          const next = [
            ...nds.map((n) => ({ ...n, selected: false })),
            { ...newNode, selected: true },
          ];
          onSelectionSnapshot({ id: newNode.id, data: newNode.data });
          return next;
        });
      },
      updateNodeData: (nodeId, patch) => {
        setNodes((nds) => {
          const next = nds.map((n) => {
            if (n.id !== nodeId) return n;
            const pluginChanged = patch.plugin !== undefined && patch.plugin !== n.data.plugin;
            const nextData: StepNodeData = {
              ...n.data,
              label: patch.label ?? n.data.label,
              plugin: patch.plugin ?? n.data.plugin,
              config: pluginChanged ? {} : (patch.config ?? n.data.config),
              priority: patch.priority !== undefined ? patch.priority : n.data.priority,
            };
            return { ...n, data: nextData };
          });
          const selected = next.find((n) => n.id === nodeId);
          if (selected?.selected) {
            onSelectionSnapshot({ id: selected.id, data: selected.data });
          }
          return next;
        });
      },
      selectNode: (nodeId: string) => {
        setNodes((nds) => {
          const next = nds.map((n) => ({ ...n, selected: n.id === nodeId }));
          const selected = next.find((n) => n.id === nodeId) ?? null;
          onSelectionSnapshot(selected ? { id: selected.id, data: selected.data } : null);
          return next;
        });
      },
    }),
    [nodes, edges, fitView, onSelectionSnapshot, setEdges, setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) => addEdge({ ...connection, ...directedEdgeOptions }, eds)),
    [setEdges],
  );

  const handleLayout = (direction: LayoutDirection) => {
    const layoutedNodes = getLayoutedNodes(nodes, edges, direction);
    setNodes(layoutedNodes);
    setEdges((eds) => assignEdgeHandles(layoutedNodes, eds));
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
  };

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      const selected = (selectedNodes[0] as Node<StepNodeData> | undefined) ?? null;
      onSelectionSnapshot(selected ? { id: selected.id, data: selected.data } : null);
    },
    [onSelectionSnapshot],
  );

  return (
    <div className="flex-1 bg-panel relative dag-flow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={handleSelectionChange}
        onNodeDoubleClick={(_event, node) => onNodeDoubleClick(node as Node<StepNodeData>)}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={directedEdgeOptions}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={directedEdgeOptions.style}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
        <Panel position="top-right" className="flex gap-1.5">
          <button
            type="button"
            onClick={() => handleLayout('LR')}
            title="水平自动布局"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-ctrl border border-line bg-surface text-xs hover:bg-raised"
          >
            <FontAwesomeIcon icon={faGripLinesVertical} />
            水平
          </button>
          <button
            type="button"
            onClick={() => handleLayout('TB')}
            title="垂直自动布局"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-ctrl border border-line bg-surface text-xs hover:bg-raised"
          >
            <FontAwesomeIcon icon={faGripLines} />
            垂直
          </button>
        </Panel>
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-sm text-faint">从左侧插件库添加步骤开始编排</p>
        </div>
      )}
      {validationErrors.length > 0 && (
        <div className="absolute bottom-4 left-4 right-4 bg-failed/10 border border-failed/30 text-failed text-sm px-4 py-2 rounded-ctrl">
          {validationErrors.join(' · ')}
        </div>
      )}
    </div>
  );
});

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';
  const flowRef = useRef<WorkflowFlowHandle>(null);

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowNameError, setWorkflowNameError] = useState('');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [schemaMap, setSchemaMap] = useState<Map<string, JsonObjectSchema | null> | null>(null);
  const [resultSchemaMap, setResultSchemaMap] = useState<Map<string, JsonObjectSchema | null>>(
    () => new Map(),
  );
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configInvalidNodeIds, setConfigInvalidNodeIds] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [failFast, setFailFast] = useState(true);
  const [maxParallel, setMaxParallel] = useState(1);

  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [topology, setTopology] = useState<TopologySnapshot>({
    nodeCount: 0,
    errors: [],
    steps: [],
  });

  const handleSelectionSnapshot = useCallback((next: SelectionSnapshot | null) => {
    setSelection((prev) => (selectionSnapshotEqual(prev, next) ? prev : next));
  }, []);

  const syncFlowFromDefinition = useCallback((definition: WorkflowDefinition) => {
    flowRef.current?.loadDefinition(definition);
    setWorkflowId(definition.id);
    setWorkflowName(definition.name);
    setSelection(null);
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      pluginsApi.list(),
      preloadPluginConfigSchemas(),
      pluginsApi.listResultSchemas(),
    ]).then(([listResult, schemaResult, resultSchemaResult]) => {
      if (listResult.status === 'fulfilled') {
        setPlugins(listResult.value);
      } else {
        toast.warning('加载插件列表失败，使用本地兜底数据');
        setPlugins([{ name: 'test-plugin', version: '1.0.0' }]);
      }
      if (resultSchemaResult.status === 'fulfilled') {
        setResultSchemaMap(
          new Map(
            resultSchemaResult.value.map((item) => [
              item.name,
              item.resultJsonSchema as JsonObjectSchema | null,
            ]),
          ),
        );
      }

      if (schemaResult.status === 'fulfilled') {
        setSchemaMap(schemaResult.value);
      } else {
        toast.warning('加载插件配置规则失败');
      }
    });
  }, []);

  useEffect(() => {
    if (!isNew && id) {
      workflowsApi
        .get(id)
        .then((record) => {
          syncFlowFromDefinition(record.definition);
        })
        .catch((e) => {
          toast.error(e instanceof Error ? e.message : '加载工作流失败');
        });
    }
  }, [id, isNew, syncFlowFromDefinition]);

  const selectedReferenceSources = useMemo((): ConfigReferenceSource[] => {
    if (!selection) return [];
    const currentId = selection.data.stepId ?? selection.data.clientRef ?? selection.id;
    const ancestors = getAncestorIds(currentId, topology.steps);
    const sources: ConfigReferenceSource[] = [];
    for (const step of topology.steps) {
      if (!ancestors.has(step.id)) continue;
      const resultSchema = resultSchemaMap.get(step.plugin);
      if (!resultSchema) continue;
      sources.push({
        stepId: step.id,
        label: step.label,
        plugin: step.plugin,
        resultSchema,
      });
    }
    return sources;
  }, [selection, topology.steps, resultSchemaMap]);

  const updateSelected = (
    patch: Partial<Pick<StepNodeData, 'label' | 'plugin' | 'config' | 'priority'>>,
  ) => {
    if (!selection) return;

    const pluginChanged = patch.plugin !== undefined && patch.plugin !== selection.data.plugin;
    const configChanged = patch.config !== undefined;
    if (pluginChanged || configChanged) {
      setConfigInvalidNodeIds(new Set());
    }

    flowRef.current?.updateNodeData(selection.id, {
      ...patch,
      ...(pluginChanged ? { config: {} } : {}),
    });
  };

  const buildCurrentDraft = () => {
    const nodes = flowRef.current?.getNodes() ?? [];
    const edges = flowRef.current?.getEdges() ?? [];
    const draft = buildDraft(nodes, edges, workflowName, workflowId);
    if (!schemaMap) return draft;

    return {
      ...draft,
      steps: draft.steps.map((step, index) => {
        const node = nodes[index];
        if (!node) return step;

        const result = validateStepConfig(step.plugin, step.config ?? {}, schemaMap);
        return result.ok ? { ...step, config: result.config } : step;
      }),
    };
  };

  const isWorkflowNameValid = !validateWorkflowName(workflowName);
  const dagValid = topology.errors.length === 0;
  const validationErrors = topology.errors;

  const handleNodeDoubleClick = useCallback((node: Node<StepNodeData>) => {
    flowRef.current?.selectNode(node.id);
    setConfigModalOpen(true);
  }, []);

  const assertWorkflowReady = useCallback((): boolean => {
    const nameError = validateWorkflowName(workflowName);
    if (nameError) {
      toast.warning(nameError);
      setWorkflowNameError(nameError);
      return false;
    }
    setWorkflowNameError('');

    const nodes = flowRef.current?.getNodes() ?? [];
    if (nodes.length === 0) {
      toast.warning('请至少添加一个步骤');
      return false;
    }

    if (!schemaMap) {
      toast.warning('插件配置规则未加载');
      return false;
    }

    if (topology.errors.length > 0) {
      toast.warning(topology.errors[0] ?? '工作流结构不合法');
      return false;
    }

    const configValidation = validateAllStepConfigs(nodes, schemaMap);
    if (!configValidation.valid) {
      setConfigInvalidNodeIds(new Set(configValidation.issues.map((issue) => issue.nodeId)));
      const configErrors = formatStepConfigIssues(configValidation.issues);
      toast.error(configErrors[0] ?? '步骤配置不完整');
      const firstIssue = configValidation.issues[0];
      if (firstIssue) {
        flowRef.current?.selectNode(firstIssue.nodeId);
      }
      return false;
    }

    for (const step of topology.steps) {
      const refs = extractContextReferences(
        nodes.find((n) => resolveNodeRef(n) === step.id)?.data.config ?? {},
      );
      if (refs.length === 0) continue;
      const ancestors = getAncestorIds(step.id, topology.steps);
      for (const ref of refs) {
        if (!ancestors.has(ref.$ref.fromStepId)) {
          toast.error(`步骤「${step.label}」引用了非祖先步骤 ${ref.$ref.fromStepId}`);
          return false;
        }
        const source = topology.steps.find((s) => s.id === ref.$ref.fromStepId);
        if (!source || !resultSchemaMap.get(source.plugin)) {
          toast.error(
            `步骤「${step.label}」引用的上游「${ref.$ref.fromStepId}」未声明 resultSchema`,
          );
          return false;
        }
      }
    }

    setConfigInvalidNodeIds(new Set());
    return true;
  }, [workflowName, schemaMap, topology.errors, topology.steps, resultSchemaMap]);

  const handleSave = async () => {
    if (!assertWorkflowReady()) return;

    setSaving(true);
    try {
      const draft = buildCurrentDraft();
      if (isNew) {
        const created = await workflowsApi.create(draft);
        syncFlowFromDefinition(created.definition);
        toast.success('工作流已保存');
        navigate(`/workflows/${created.id}/edit`, { replace: true });
      } else if (workflowId) {
        const updated = await workflowsApi.update(workflowId, draft);
        syncFlowFromDefinition(updated.definition);
        toast.success('工作流已保存');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setWorkflowNameError(error.message);
      } else {
        toast.error(error instanceof Error ? error.message : '保存工作流失败');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!assertWorkflowReady()) return;

    setRunning(true);
    try {
      const draft = buildCurrentDraft();
      const { runId } = await runsApi.submit(draft, { traceId: `web-${Date.now()}` });
      navigate(`/runs/${runId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '运行工作流失败');
    } finally {
      setRunning(false);
    }
  };

  const actions = (
    <>
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !dagValid || topology.nodeCount === 0 || !isWorkflowNameValid}
        title={validationErrors.join('; ') || undefined}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faSave} />
        保存
      </button>
      <button
        type="button"
        onClick={handleRun}
        disabled={!dagValid || running || topology.nodeCount === 0 || !isWorkflowNameValid}
        title={validationErrors.join('; ') || undefined}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faPlay} />
        运行
      </button>
    </>
  );

  const selectedStepId = selection?.data.stepId;

  return (
    <FullscreenLayout
      backTo="/workflows"
      backLabel="工作流"
      title={workflowName.trim() || '未命名工作流'}
      actions={actions}
    >
      <div className="flex h-full">
        <aside className="w-56 shrink-0 border-r border-line bg-surface p-4 overflow-auto">
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">插件库</h3>
          <div className="space-y-1">
            {plugins.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => flowRef.current?.addStep(p.name)}
                className="w-full text-left px-3 py-2 rounded-ctrl text-sm hover:bg-raised border border-transparent hover:border-line"
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-faint truncate">{p.description ?? p.version}</div>
              </button>
            ))}
          </div>
        </aside>

        <ReactFlowProvider>
          <WorkflowFlow
            ref={flowRef}
            configInvalidNodeIds={configInvalidNodeIds}
            onSelectionSnapshot={handleSelectionSnapshot}
            onTopologyChange={setTopology}
            onNodeDoubleClick={handleNodeDoubleClick}
          />
        </ReactFlowProvider>

        <aside className="w-72 shrink-0 border-l border-line bg-surface p-4 overflow-auto">
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">工作流</h3>
          <Field label="ID" htmlFor="workflow-id">
            <Input
              id="workflow-id"
              mono
              readOnly
              value={workflowId ?? ''}
              placeholder="保存后生成"
            />
          </Field>
          <Field
            label="名称"
            htmlFor="workflow-name"
            className="mb-4"
            error={workflowNameError || undefined}
          >
            <Input
              id="workflow-name"
              value={workflowName}
              placeholder="请输入工作流名称"
              onChange={(e) => {
                setWorkflowName(e.target.value);
                if (workflowNameError) {
                  setWorkflowNameError(validateWorkflowName(e.target.value) ?? '');
                }
              }}
            />
          </Field>

          <div className="flex gap-4 mb-4 text-sm items-center">
            <Checkbox
              id="fail-fast"
              checked={failFast}
              onCheckedChange={setFailFast}
              label="failFast"
            />
            <label className="flex items-center gap-2 text-muted whitespace-nowrap">
              并行
              <Input
                type="number"
                min={1}
                className="w-14 h-8 px-2"
                value={maxParallel}
                onChange={(e) => setMaxParallel(Number(e.target.value))}
              />
            </label>
          </div>

          {selection ? (
            <>
              <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3 mt-6">
                步骤属性
              </h3>
              <Field label="步骤 ID" htmlFor="step-id">
                <Input
                  id="step-id"
                  mono
                  readOnly
                  value={selectedStepId ?? ''}
                  placeholder="保存后生成"
                />
              </Field>
              <Field label="名称" htmlFor="step-name">
                <Input
                  id="step-name"
                  value={selection.data.label}
                  onChange={(e) => updateSelected({ label: e.target.value })}
                />
              </Field>
              <Field label="插件" htmlFor="step-plugin">
                <Select
                  id="step-plugin"
                  value={selection.data.plugin}
                  onValueChange={(plugin) => updateSelected({ plugin })}
                  options={plugins.map((p) => ({ value: p.name, label: p.name }))}
                />
              </Field>
              <Field label="配置">
                <button
                  type="button"
                  onClick={() => setConfigModalOpen(true)}
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-ctrl border border-line text-sm hover:bg-raised w-full justify-center"
                >
                  <FontAwesomeIcon icon={faCog} />
                  编辑配置
                </button>
                <p className="mt-2 text-xs text-faint font-mono truncate">
                  {JSON.stringify(selection.data.config ?? {})}
                </p>
              </Field>
              <PluginConfigFormModal
                open={configModalOpen}
                onOpenChange={setConfigModalOpen}
                pluginName={selection.data.plugin}
                value={(selection.data.config ?? {}) as Record<string, unknown>}
                onConfirm={(config) => updateSelected({ config })}
                referenceSources={selectedReferenceSources}
              />
            </>
          ) : (
            <p className="text-sm text-faint mt-6">点击画布中的节点编辑属性，双击打开配置</p>
          )}
        </aside>
      </div>
    </FullscreenLayout>
  );
}
