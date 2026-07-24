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
import {
  extractContextReferences,
  getStepKind,
  isPluginStep,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
  type StepKind,
  type StepKindDefinition,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlay,
  faSave,
  faGripLinesVertical,
  faGripLines,
  faFileImport,
  faSliders,
} from '@fortawesome/free-solid-svg-icons';
import { stepKindsApi, workflowsApi, type WorkflowDraft } from '../../shared/api/workflows';
import { runsApi } from '../../shared/api/runs';
import { ApiError } from '../../shared/api/http';
import { pluginsApi } from '../../shared/api/misc';
import type { PluginInfo, WorkflowImportRecord } from '../../shared/types';
import { getAncestorIds, validateDag } from './dag-utils';
import {
  BUILTIN_RESULT_SCHEMAS,
  formatStepConfigIssues,
  nodeDataToDraftStep,
  resultSchemaKeyForStep,
  validateAllStepConfigs,
  validateStepConfig,
} from './step-config-validation';
import { ImportWorkflowModal } from './ImportWorkflowModal';
import { EditableWorkflowTitle } from './EditableWorkflowTitle';
import { StepInspectorPanel } from './StepInspectorPanel';
import { WorkflowSettingsModal } from './WorkflowSettingsModal';
import { defaultWorkflowName, validateWorkflowName } from './workflow-name';
import { FullscreenLayout } from '../../layouts/FullscreenLayout';
import { Field, Input, Checkbox, Textarea } from '../../shared/ui/form';
import { preloadPluginConfigSchemas } from '../../shared/plugins';
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
import { Modal } from '../../shared/ui/Modal';

interface StepNodeData {
  label: string;
  kind: StepKind;
  plugin?: string;
  clientRef: string;
  stepId?: string;
  config?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  workflowRef?: { importId: string };
  inputState?: unknown;
  loop?: {
    maxIterations: number;
    until?: { when: string; equals?: unknown; exists?: boolean };
  };
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
  kind: StepKind;
  plugin?: string;
  label: string;
  dependsOn: string[];
}

interface TopologySnapshot {
  nodeCount: number;
  errors: string[];
  steps: EditorStep[];
}

type PaletteItem =
  | { type: 'plugin'; plugin: PluginInfo }
  | { type: 'builtin'; definition: StepKindDefinition }
  | { type: 'workflow-import'; importId: string; label: string; mode: string };

export interface WorkflowFlowHandle {
  getNodes: () => Node<StepNodeData>[];
  getEdges: () => Edge[];
  loadDefinition: (definition: WorkflowDefinition) => void;
  addPaletteItem: (item: PaletteItem) => void;
  updateNodeData: (nodeId: string, patch: Partial<StepNodeData>) => void;
  selectNode: (nodeId: string) => void;
}

function stepSubtitle(data: StepNodeData): string {
  if (data.kind === StepKinds.SET_STATE) return 'set_state';
  if (data.kind === StepKinds.WORKFLOW) return 'workflow';
  return data.plugin ?? 'plugin';
}

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const handleClass = selected
    ? '!w-2 !h-2 !bg-brand !border-2 !border-white'
    : '!w-1.5 !h-1.5 !bg-line !border !border-white';

  const kindBorder =
    data.kind === StepKinds.WORKFLOW
      ? 'border-brand/40 border-dashed'
      : data.kind === StepKinds.SET_STATE
        ? 'border-warning/40'
        : 'border-line';

  const borderClass = data.configInvalid
    ? 'border-failed bg-failed/5'
    : selected
      ? 'border-brand/50'
      : `${kindBorder} node-idle hover:border-faint/40`;

  return (
    <div
      className={`px-2.5 py-1.5 rounded-ctrl min-w-[100px] max-w-[140px] border transition-[border-color,background-color,box-shadow] duration-150 ${
        selected ? 'bg-brand-soft node-selected' : 'bg-surface'
      } ${borderClass} relative`}
    >
      <FlowNodeHandles className={`${handleClass} !z-10`} />
      {data.kind === StepKinds.WORKFLOW && (
        <span className="absolute -top-1.5 -right-1.5 text-[9px] px-1 rounded bg-brand text-white">
          子
        </span>
      )}
      <div className={`text-xs font-medium truncate leading-tight ${selected ? 'text-ink' : ''}`}>
        {data.label}
      </div>
      <div
        className={`text-[10px] font-mono truncate leading-tight mt-0.5 ${selected ? 'text-brand' : 'text-faint'}`}
      >
        {stepSubtitle(data)}
      </div>
    </div>
  );
});

const nodeTypes = { step: StepNode };

function createClientRef() {
  return crypto.randomUUID();
}

function stepToNodeData(step: WorkflowStep): StepNodeData {
  const kind = getStepKind(step);
  const base: StepNodeData = {
    label: step.name,
    kind,
    clientRef: step.id,
    stepId: step.id,
    priority: step.priority,
  };

  if (isSetStateStep(step)) {
    return { ...base, patch: step.patch };
  }
  if (isWorkflowRefStep(step)) {
    return {
      ...base,
      workflowRef: step.workflowRef,
      inputState: step.inputState,
      loop: step.loop,
    };
  }
  if (isPluginStep(step)) {
    return { ...base, plugin: step.plugin, config: step.config };
  }
  return { ...base, plugin: '', config: {} };
}

function definitionToFlow(definition: WorkflowDefinition): {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<StepNodeData>[] = definition.steps.map((step) => ({
    id: step.id,
    type: 'step',
    position: { x: 0, y: 0 },
    data: stepToNodeData(step),
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
  stateSchema: Record<string, unknown> | undefined,
): WorkflowDraft {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return {
    ...(workflowId ? { id: workflowId } : {}),
    name: workflowName,
    ...(stateSchema ? { stateSchema } : {}),
    steps: nodes.map((node) => {
      const deps = edges
        .filter((e) => e.target === node.id)
        .map((e) => {
          const source = nodeById.get(e.source);
          return source ? resolveNodeRef(source) : e.source;
        });

      return nodeDataToDraftStep(
        {
          label: node.data.label,
          kind: node.data.kind,
          plugin: node.data.plugin,
          config: node.data.config,
          patch: node.data.patch,
          workflowRef: node.data.workflowRef,
          inputState: node.data.inputState,
          loop: node.data.loop,
          clientRef: node.data.clientRef ?? node.id,
          stepId: node.data.stepId,
          priority: node.data.priority,
        },
        deps,
      );
    }),
  };
}

function dagStepsFromNodes(nodes: Node<StepNodeData>[], edges: Edge[]) {
  return nodes.map((node) => ({
    id: node.id,
    dependsOn: edges.filter((e) => e.target === node.id).map((e) => e.source),
  }));
}

function topologyKey(nodes: Node<StepNodeData>[], edges: Edge[]): string {
  const nodePart = nodes
    .map(
      (n) =>
        `${n.id}\0${resolveNodeRef(n)}\0${n.data.kind}\0${n.data.plugin ?? ''}\0${n.data.label}`,
    )
    .join('\n');
  const edgePart = edges.map((e) => `${e.source}\0${e.target}`).join('\n');
  return `${nodePart}|${edgePart}`;
}

function buildEditorSteps(nodes: Node<StepNodeData>[], edges: Edge[]): EditorStep[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((node) => ({
    id: resolveNodeRef(node),
    kind: node.data.kind,
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

function collectRefsFromNode(data: StepNodeData) {
  if (data.kind === StepKinds.SET_STATE) {
    return extractContextReferences(data.patch ?? {});
  }
  if (data.kind === StepKinds.WORKFLOW) {
    return extractContextReferences({
      inputState: data.inputState,
    });
  }
  return extractContextReferences(data.config ?? {});
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
      addPaletteItem: (item: PaletteItem) => {
        const clientRef = createClientRef();
        const count = nodes.length;
        const data: StepNodeData =
          item.type === 'workflow-import'
            ? {
                label: item.label,
                kind: StepKinds.WORKFLOW,
                clientRef,
                workflowRef: { importId: item.importId },
              }
            : item.type === 'builtin'
              ? item.definition.kind === StepKinds.SET_STATE
                ? {
                    label: item.definition.label,
                    kind: StepKinds.SET_STATE,
                    clientRef,
                    patch: {},
                  }
                : {
                    label: item.definition.label,
                    kind: StepKinds.WORKFLOW,
                    clientRef,
                    workflowRef: { importId: '' },
                  }
              : {
                  label: `步骤 ${count + 1}`,
                  kind: StepKinds.PLUGIN,
                  plugin: item.plugin.name,
                  clientRef,
                  config: {},
                };

        const newNode: Node<StepNodeData> = {
          id: clientRef,
          type: 'step',
          position: { x: 120 + count * 40, y: 200 },
          data,
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
              ...patch,
              config: pluginChanged ? {} : (patch.config ?? n.data.config),
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
          <p className="text-sm text-faint">从左侧节点面板添加步骤开始编排</p>
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
  const [workflowName, setWorkflowName] = useState(defaultWorkflowName);
  const [workflowNameError, setWorkflowNameError] = useState('');
  const [stateSchema, setStateSchema] = useState<Record<string, unknown> | undefined>();
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [stepKinds, setStepKinds] = useState<StepKindDefinition[]>([]);
  const [imports, setImports] = useState<WorkflowImportRecord[]>([]);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [schemaMap, setSchemaMap] = useState<Map<string, JsonObjectSchema | null> | null>(null);
  const [resultSchemaMap, setResultSchemaMap] = useState<Map<string, JsonObjectSchema | null>>(
    () => new Map(),
  );
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [initialStateText, setInitialStateText] = useState('');
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

  const refreshImports = useCallback(async (wfId: string) => {
    try {
      const rows = await workflowsApi.listImports(wfId);
      setImports(rows);
    } catch {
      setImports([]);
    }
  }, []);

  const syncFlowFromDefinition = useCallback(
    (definition: WorkflowDefinition) => {
      flowRef.current?.loadDefinition(definition);
      setWorkflowId(definition.id);
      setWorkflowName(definition.name);
      setStateSchema(definition.stateSchema as Record<string, unknown> | undefined);
      setSelection(null);
      void refreshImports(definition.id);
    },
    [refreshImports],
  );

  useEffect(() => {
    void Promise.allSettled([
      pluginsApi.list(),
      stepKindsApi.list(),
      preloadPluginConfigSchemas(),
      pluginsApi.listResultSchemas(),
    ]).then(([listResult, kindsResult, schemaResult, resultSchemaResult]) => {
      if (listResult.status === 'fulfilled') {
        setPlugins(listResult.value);
      } else {
        toast.warning('加载插件列表失败，使用本地兜底数据');
        setPlugins([{ name: 'test-plugin', version: '1.0.0' }]);
      }
      if (kindsResult.status === 'fulfilled') {
        setStepKinds(kindsResult.value);
      }
      if (resultSchemaResult.status === 'fulfilled') {
        const map = new Map<string, JsonObjectSchema | null>(
          resultSchemaResult.value.map((item) => [
            item.name,
            item.resultJsonSchema as JsonObjectSchema | null,
          ]),
        );
        for (const [key, schema] of Object.entries(BUILTIN_RESULT_SCHEMAS)) {
          map.set(key, schema);
        }
        setResultSchemaMap(map);
      } else {
        setResultSchemaMap(new Map(Object.entries(BUILTIN_RESULT_SCHEMAS)));
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
      const key = resultSchemaKeyForStep(step);
      if (!key) continue;
      const resultSchema = resultSchemaMap.get(key);
      if (!resultSchema) continue;
      sources.push({
        stepId: step.id,
        label: step.label,
        plugin: key,
        resultSchema,
      });
    }
    return sources;
  }, [selection, topology.steps, resultSchemaMap]);

  const updateSelected = (patch: Partial<StepNodeData>) => {
    if (!selection) return;
    if (patch.plugin !== undefined || patch.config !== undefined) {
      setConfigInvalidNodeIds(new Set());
    }
    flowRef.current?.updateNodeData(selection.id, patch);
  };

  const buildCurrentDraft = () => {
    const nodes = flowRef.current?.getNodes() ?? [];
    const edges = flowRef.current?.getEdges() ?? [];
    const draft = buildDraft(nodes, edges, workflowName, workflowId, stateSchema);
    if (!schemaMap) return draft;

    return {
      ...draft,
      steps: draft.steps.map((step, index) => {
        const node = nodes[index];
        if (!node || node.data.kind !== StepKinds.PLUGIN) return step;
        const plugin = node.data.plugin;
        if (!plugin) return step;
        const result = validateStepConfig(plugin, node.data.config ?? {}, schemaMap);
        return result.ok ? { ...step, config: result.config } : step;
      }),
    };
  };

  const isWorkflowNameValid = !validateWorkflowName(workflowName);
  const dagValid = topology.errors.length === 0;
  const validationErrors = topology.errors;

  const handleNodeDoubleClick = useCallback((node: Node<StepNodeData>) => {
    flowRef.current?.selectNode(node.id);
    if (node.data.kind === StepKinds.PLUGIN) {
      setConfigModalOpen(true);
    }
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

    const hasSetState = nodes.some((n) => n.data.kind === StepKinds.SET_STATE);
    if (hasSetState && !stateSchema) {
      toast.error('存在 set_state 步骤时须在工作流设置中声明 stateSchema');
      return false;
    }

    for (const node of nodes) {
      if (node.data.kind === StepKinds.WORKFLOW && !node.data.workflowRef?.importId) {
        toast.error(`步骤「${node.data.label}」未选择已导入的子工作流`);
        flowRef.current?.selectNode(node.id);
        return false;
      }
    }

    const stepNameCounts = new Map<string, string[]>();
    for (const node of nodes) {
      const name = node.data.label.trim();
      if (!name) {
        toast.error('每个步骤需要非空名称');
        flowRef.current?.selectNode(node.id);
        return false;
      }
      const ids = stepNameCounts.get(name) ?? [];
      ids.push(node.id);
      stepNameCounts.set(name, ids);
    }
    for (const [name, ids] of stepNameCounts) {
      if (ids.length > 1) {
        toast.error(`步骤名称「${name}」重复`);
        flowRef.current?.selectNode(ids[0]!);
        return false;
      }
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
      const node = nodes.find((n) => resolveNodeRef(n) === step.id);
      if (!node) continue;
      const refs = collectRefsFromNode(node.data);
      if (refs.length === 0) continue;
      const ancestors = getAncestorIds(step.id, topology.steps);
      for (const ref of refs) {
        if (!ancestors.has(ref.$ref.fromStepId)) {
          toast.error(`步骤「${step.label}」引用了非祖先步骤 ${ref.$ref.fromStepId}`);
          return false;
        }
        const source = topology.steps.find((s) => s.id === ref.$ref.fromStepId);
        const key = source ? resultSchemaKeyForStep(source) : undefined;
        if (!source || !key || !resultSchemaMap.get(key)) {
          toast.error(
            `步骤「${step.label}」引用的上游「${ref.$ref.fromStepId}」未声明 resultSchema`,
          );
          return false;
        }
      }
    }

    setConfigInvalidNodeIds(new Set());
    return true;
  }, [workflowName, schemaMap, topology.errors, topology.steps, resultSchemaMap, stateSchema]);

  const handleSave = async () => {
    if (!assertWorkflowReady()) return;

    setSaving(true);
    try {
      const draft = buildCurrentDraft();
      if (isNew || !workflowId) {
        const created = await workflowsApi.create(draft);
        syncFlowFromDefinition(created.definition);
        toast.success('工作流已保存');
        navigate(`/workflows/${created.id}/edit`, { replace: true });
      } else {
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

  const handleRunConfirm = async () => {
    if (!assertWorkflowReady()) return;

    let initialState: unknown;
    if (stateSchema) {
      const raw = initialStateText.trim();
      if (raw) {
        try {
          initialState = JSON.parse(raw) as unknown;
        } catch {
          toast.error('initialState JSON 无效');
          return;
        }
      }
    }

    setRunning(true);
    try {
      const draft = buildCurrentDraft();
      const { runId } = await runsApi.submit(draft, {
        traceId: `web-${Date.now()}`,
        ...(initialState !== undefined ? { initialState } : {}),
      });
      setRunModalOpen(false);
      navigate(`/runs/${runId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '运行工作流失败');
    } finally {
      setRunning(false);
    }
  };

  const handleAddBuiltin = (definition: StepKindDefinition) => {
    if (definition.kind === StepKinds.SET_STATE && !stateSchema) {
      toast.warning('请先在「工作流设置」中声明 stateSchema，再添加 set_state 步骤');
    }
    flowRef.current?.addPaletteItem({ type: 'builtin', definition });
  };

  const handleAddWorkflowImport = (row: WorkflowImportRecord) => {
    const label = row.childWorkflowName ?? row.childWorkflowId;
    flowRef.current?.addPaletteItem({
      type: 'workflow-import',
      importId: row.id,
      label,
      mode: row.mode,
    });
  };

  const controlFlowKinds = stepKinds.filter((kind) => kind.kind !== StepKinds.WORKFLOW);

  const openImportModal = () => {
    if (!workflowId) {
      toast.warning('请先保存工作流，再导入子工作流');
      return;
    }
    setImportModalOpen(true);
  };

  const actions = (
    <>
      <div className="flex items-center gap-4 text-sm mr-1">
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
      <button
        type="button"
        onClick={() => setSettingsModalOpen(true)}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
      >
        <FontAwesomeIcon icon={faSliders} />
        工作流设置
      </button>
      <button
        type="button"
        onClick={openImportModal}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
      >
        <FontAwesomeIcon icon={faFileImport} />
        导入子工作流
      </button>
      <button
        type="button"
        onClick={() => void handleSave()}
        disabled={saving || !dagValid || topology.nodeCount === 0 || !isWorkflowNameValid}
        title={validationErrors.join('; ') || undefined}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faSave} />
        保存
      </button>
      <button
        type="button"
        onClick={() => {
          if (!assertWorkflowReady()) return;
          setInitialStateText('');
          setRunModalOpen(true);
        }}
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
  const importOptions = imports.map((row) => ({
    id: row.id,
    label: row.childWorkflowName ?? row.childWorkflowId,
    mode: row.mode,
  }));
  const selectedImport = selection?.data.workflowRef?.importId
    ? importOptions.find((row) => row.id === selection.data.workflowRef?.importId)
    : undefined;

  return (
    <FullscreenLayout
      backTo="/workflows"
      backLabel="工作流"
      title={
        <EditableWorkflowTitle
          value={workflowName}
          onChange={setWorkflowName}
          error={workflowNameError || undefined}
          onErrorChange={setWorkflowNameError}
        />
      }
      actions={actions}
    >
      <div className="flex h-full">
        <aside className="w-56 shrink-0 border-r border-line bg-surface p-4 overflow-auto">
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">控制流</h3>
          <div className="space-y-1 mb-6">
            {controlFlowKinds.map((kind) => (
              <button
                key={kind.kind}
                type="button"
                onClick={() => handleAddBuiltin(kind)}
                className="w-full text-left px-3 py-2 rounded-ctrl text-sm hover:bg-raised border border-transparent hover:border-line"
              >
                <div className="font-medium">{kind.label}</div>
                <div className="text-xs text-faint truncate">{kind.description}</div>
              </button>
            ))}
          </div>
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">子工作流</h3>
          <div className="space-y-1 mb-6">
            {imports.length === 0 ? (
              <p className="px-3 py-2 text-xs text-faint">请先导入子工作流</p>
            ) : (
              imports.map((row) => {
                const label = row.childWorkflowName ?? row.childWorkflowId;
                const modeLabel = row.mode === 'copy' ? '拷贝' : '引用';
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => handleAddWorkflowImport(row)}
                    className="w-full text-left px-3 py-2 rounded-ctrl text-sm hover:bg-raised border border-transparent hover:border-line"
                  >
                    <div className="font-medium truncate">{label}</div>
                    <div className="text-xs text-faint truncate">{modeLabel}</div>
                  </button>
                );
              })
            )}
          </div>
          <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3">插件</h3>
          <div className="space-y-1">
            {plugins.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => flowRef.current?.addPaletteItem({ type: 'plugin', plugin: p })}
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

        <StepInspectorPanel
          selection={selection}
          selectedStepId={selectedStepId}
          selectedImport={selectedImport}
          configModalOpen={configModalOpen}
          onConfigModalOpenChange={setConfigModalOpen}
          referenceSources={selectedReferenceSources}
          onUpdate={updateSelected}
        />
      </div>

      <WorkflowSettingsModal
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        workflowId={workflowId}
        workflowName={workflowName}
        onWorkflowNameChange={setWorkflowName}
        workflowNameError={workflowNameError}
        onWorkflowNameErrorChange={setWorkflowNameError}
        stateSchema={stateSchema}
        onStateSchemaChange={setStateSchema}
      />

      {workflowId && (
        <ImportWorkflowModal
          open={importModalOpen}
          onOpenChange={setImportModalOpen}
          parentWorkflowId={workflowId}
          imports={imports}
          onImported={() => void refreshImports(workflowId)}
        />
      )}

      <Modal
        open={runModalOpen}
        onOpenChange={setRunModalOpen}
        title="运行工作流"
        footer={
          <>
            <button
              type="button"
              className="h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised"
              onClick={() => setRunModalOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={running}
              className="h-9 px-4 rounded-ctrl bg-brand text-white text-sm hover:bg-brand-hover disabled:opacity-50"
              onClick={() => void handleRunConfirm()}
            >
              {running ? '提交中…' : '开始运行'}
            </button>
          </>
        }
      >
        {stateSchema ? (
          <Field label="initialState（JSON，可选）">
            <Textarea
              rows={8}
              value={initialStateText}
              placeholder="{}"
              onChange={(e) => setInitialStateText(e.target.value)}
            />
          </Field>
        ) : (
          <p className="text-sm text-muted">本工作流未声明 stateSchema，将直接提交运行。</p>
        )}
      </Modal>
    </FullscreenLayout>
  );
}
