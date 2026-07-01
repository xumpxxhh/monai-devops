import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faSave } from '@fortawesome/free-solid-svg-icons';
import { workflowsApi, type WorkflowDraft } from '../../shared/api/workflows';
import { runsApi } from '../../shared/api/runs';
import { ApiError } from '../../shared/api/http';
import { pluginsApi } from '../../shared/api/misc';
import type { PluginInfo } from '../../shared/types';
import { validateDag } from './dag-utils';
import { FullscreenLayout } from '../../layouts/FullscreenLayout';
import { Field, Input, Textarea, Select, Checkbox } from '../../shared/ui/form';
import { toast } from 'sonner';

interface StepNodeData {
  label: string;
  plugin: string;
  clientRef: string;
  stepId?: string;
  config?: Record<string, unknown>;
  priority?: number;
  [key: string]: unknown;
}

function StepNode({ data }: { data: StepNodeData }) {
  return (
    <div className="px-4 py-3 rounded-ctrl bg-surface border border-line min-w-[140px] node-idle">
      <Handle type="target" position={Position.Top} className="!bg-line" />
      <div className="text-sm font-medium truncate">{data.label}</div>
      <div className="text-xs text-faint font-mono truncate">{data.plugin}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-line" />
    </div>
  );
}

const nodeTypes = { step: StepNode };

function createClientRef() {
  return crypto.randomUUID();
}

function definitionToFlow(definition: WorkflowDefinition): {
  nodes: Node<StepNodeData>[];
  edges: Edge[];
} {
  const nodes: Node[] = definition.steps.map((step, i) => ({
    id: step.id,
    type: 'step',
    position: { x: 120 + (i % 3) * 200, y: 80 + Math.floor(i / 3) * 120 },
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
      edges.push({ id: `${dep}->${step.id}`, source: dep, target: step.id, animated: false });
    }
  }
  return { nodes: nodes as Node<StepNodeData>[], edges };
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
  selectedNodeId: string | null,
  configJson: string,
): WorkflowDraft {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return {
    ...(workflowId ? { id: workflowId } : {}),
    name: workflowName,
    steps: nodes.map((node) => {
      const data = node.data;
      let config = data.config ?? { type: 'integration' };
      if (node.id === selectedNodeId) {
        try {
          config = JSON.parse(configJson) as Record<string, unknown>;
        } catch {
          // keep existing config when JSON invalid
        }
      }

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

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowNameError, setWorkflowNameError] = useState('');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configJson, setConfigJson] = useState('{"type":"integration"}');
  const [configError, setConfigError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [failFast, setFailFast] = useState(true);
  const [maxParallel, setMaxParallel] = useState(1);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const syncFlowFromDefinition = useCallback(
    (definition: WorkflowDefinition) => {
      const flow = definitionToFlow(definition);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setWorkflowId(definition.id);
      setWorkflowName(definition.name);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    pluginsApi
      .list()
      .then(setPlugins)
      .catch(() => {
        toast.warning('加载插件列表失败，使用本地兜底数据');
        setPlugins([{ name: 'test-plugin', version: '1.0.0' }]);
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

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const dagValidation = useMemo(() => validateDag(dagStepsFromNodes(nodes, edges)), [nodes, edges]);
  const validationErrors = dagValidation.errors;

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
  const selectedStepId = selectedNode?.data.stepId;

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      const config = (node.data as StepNodeData).config ?? { type: 'integration' };
      setConfigJson(JSON.stringify(config, null, 2));
      setConfigError('');
    }
  };

  const addStep = (plugin: string) => {
    const clientRef = createClientRef();
    const newNode: Node<StepNodeData> = {
      id: clientRef,
      type: 'step',
      position: { x: 120 + nodes.length * 40, y: 200 },
      data: {
        label: `步骤 ${nodes.length + 1}`,
        plugin,
        clientRef,
        config: { type: 'integration' },
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedNodeId(clientRef);
    setConfigJson(JSON.stringify({ type: 'integration' }, null, 2));
    setConfigError('');
  };

  const updateSelected = (
    patch: Partial<Pick<StepNodeData, 'label' | 'plugin' | 'config' | 'priority'>>,
  ) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNodeId
          ? {
              ...n,
              data: {
                ...n.data,
                label: patch.label ?? n.data.label,
                plugin: patch.plugin ?? n.data.plugin,
                config: patch.config ?? n.data.config,
                priority: patch.priority,
              },
            }
          : n,
      ),
    );
  };

  const buildCurrentDraft = () =>
    buildDraft(nodes, edges, workflowName, workflowId, selectedNodeId, configJson);

  const isWorkflowNameValid = !validateWorkflowName(workflowName);

  const handleSave = async () => {
    const nameError = validateWorkflowName(workflowName);
    if (nameError) {
      toast.warning(nameError);
      return;
    }
    if (nodes.length === 0) {
      toast.warning('请至少添加一个步骤');
      return;
    }
    setWorkflowNameError('');

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
    const nameError = validateWorkflowName(workflowName);
    if (nameError) {
      setWorkflowNameError(nameError);
      return;
    }
    if (!dagValidation.valid || nodes.length === 0) return;
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
        disabled={saving}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl border border-line text-sm hover:bg-raised disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faSave} />
        保存
      </button>
      <button
        type="button"
        onClick={handleRun}
        disabled={!dagValidation.valid || running || nodes.length === 0 || !isWorkflowNameValid}
        title={validationErrors.join('; ') || undefined}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faPlay} />
        运行
      </button>
    </>
  );

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
                onClick={() => addStep(p.name)}
                className="w-full text-left px-3 py-2 rounded-ctrl text-sm hover:bg-raised border border-transparent hover:border-line"
              >
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-faint truncate">{p.description ?? p.version}</div>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex-1 bg-panel relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => selectNode(node.id)}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
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

          {selectedNode ? (
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
                  value={selectedNode.data.label}
                  onChange={(e) => updateSelected({ label: e.target.value })}
                />
              </Field>
              <Field label="插件" htmlFor="step-plugin">
                <Select
                  id="step-plugin"
                  value={selectedNode.data.plugin}
                  onValueChange={(plugin) => updateSelected({ plugin })}
                  options={plugins.map((p) => ({ value: p.name, label: p.name }))}
                />
              </Field>
              <Field label="Config JSON" htmlFor="step-config" error={configError || undefined}>
                <Textarea
                  id="step-config"
                  mono
                  className="h-32"
                  value={configJson}
                  onChange={(e) => {
                    setConfigJson(e.target.value);
                    try {
                      JSON.parse(e.target.value);
                      setConfigError('');
                      updateSelected({ config: JSON.parse(e.target.value) });
                    } catch {
                      setConfigError('JSON 格式无效');
                    }
                  }}
                />
              </Field>
            </>
          ) : (
            <p className="text-sm text-faint mt-6">点击画布中的节点编辑属性</p>
          )}
        </aside>
      </div>
    </FullscreenLayout>
  );
}
