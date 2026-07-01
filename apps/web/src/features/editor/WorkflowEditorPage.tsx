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
import type { WorkflowDefinition, WorkflowStep } from '@monai-devops/core-engine';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay, faSave } from '@fortawesome/free-solid-svg-icons';
import { workflowsApi } from '../../shared/api/workflows';
import { runsApi } from '../../shared/api/runs';
import { pluginsApi } from '../../shared/api/misc';
import type { PluginInfo } from '../../shared/types';
import { validateDag, generateStepId } from './dag-utils';
import { FullscreenLayout } from '../../layouts/FullscreenLayout';
import { Field, Input, Textarea, Select, Checkbox } from '../../shared/ui/form';

interface StepNodeData {
  label: string;
  plugin: string;
  status?: string;
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

function stepsToFlow(steps: WorkflowStep[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = steps.map((step, i) => ({
    id: step.id,
    type: 'step',
    position: { x: 120 + (i % 3) * 200, y: 80 + Math.floor(i / 3) * 120 },
    data: { label: step.name, plugin: step.plugin },
  }));
  const edges: Edge[] = [];
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      edges.push({ id: `${dep}->${step.id}`, source: dep, target: step.id, animated: false });
    }
  }
  return { nodes, edges };
}

function flowToSteps(nodes: Node[], edges: Edge[]): WorkflowStep[] {
  const depsMap = new Map<string, string[]>();
  for (const edge of edges) {
    const list = depsMap.get(edge.target) ?? [];
    list.push(edge.source);
    depsMap.set(edge.target, list);
  }
  return nodes.map((node) => {
    const extra = node.data as StepNodeData & {
      config?: Record<string, unknown>;
      priority?: number;
    };
    return {
      id: node.id,
      name: extra.label ?? node.id,
      plugin: extra.plugin ?? 'test-plugin',
      config: extra.config ?? { type: 'integration' },
      dependsOn: depsMap.get(node.id) ?? [],
      priority: extra.priority,
    };
  });
}

const DEFAULT_WORKFLOW: WorkflowDefinition = {
  id: 'new-workflow',
  name: '新工作流',
  steps: [
    {
      id: 'step-1',
      name: '集成测试',
      plugin: 'test-plugin',
      config: { type: 'integration' },
      dependsOn: [],
    },
  ],
};

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [workflowId, setWorkflowId] = useState('new-workflow');
  const [workflowName, setWorkflowName] = useState('新工作流');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configJson, setConfigJson] = useState('{"type":"integration"}');
  const [configError, setConfigError] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [failFast, setFailFast] = useState(true);
  const [maxParallel, setMaxParallel] = useState(1);

  const initial = useMemo(() => stepsToFlow(DEFAULT_WORKFLOW.steps), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  useEffect(() => {
    pluginsApi
      .list()
      .then(setPlugins)
      .catch(() => setPlugins([{ name: 'test-plugin', version: '1.0.0' }]));
  }, []);

  useEffect(() => {
    if (!isNew && id) {
      workflowsApi
        .get(id)
        .then((record) => {
          const wf = record.definition;
          setWorkflowId(wf.id);
          setWorkflowName(wf.name);
          const flow = stepsToFlow(wf.steps);
          setNodes(flow.nodes);
          setEdges(flow.edges);
        })
        .catch(() => {});
    }
  }, [id, isNew, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const steps = useMemo(() => flowToSteps(nodes, edges), [nodes, edges]);
  const dagValidation = useMemo(() => validateDag(steps), [steps]);
  const validationErrors = dagValidation.errors;

  const selectedStep = selectedNodeId ? steps.find((s) => s.id === selectedNodeId) : null;

  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const step = steps.find((s) => s.id === nodeId);
    if (step) {
      setConfigJson(JSON.stringify(step.config ?? {}, null, 2));
      setConfigError('');
    }
  };

  const addStep = (plugin: string) => {
    const ids = nodes.map((n) => n.id);
    const newId = generateStepId(ids);
    const newNode: Node = {
      id: newId,
      type: 'step',
      position: { x: 120 + nodes.length * 40, y: 200 },
      data: { label: `步骤 ${nodes.length + 1}`, plugin, config: { type: 'integration' } },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedNodeId(newId);
    setConfigJson(JSON.stringify({ type: 'integration' }, null, 2));
    setConfigError('');
  };

  const updateSelected = (patch: Partial<WorkflowStep>) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNodeId
          ? {
              ...n,
              id: patch.id ?? n.id,
              data: {
                ...n.data,
                label: patch.name ?? (n.data as StepNodeData).label,
                plugin: patch.plugin ?? (n.data as StepNodeData).plugin,
                config: patch.config ?? (n.data as StepNodeData).config,
                priority: patch.priority,
              },
            }
          : n,
      ),
    );
    if (patch.id && patch.id !== selectedNodeId) {
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          source: e.source === selectedNodeId ? patch.id! : e.source,
          target: e.target === selectedNodeId ? patch.id! : e.target,
          id: e.id.replace(selectedNodeId, patch.id!),
        })),
      );
      setSelectedNodeId(patch.id);
    }
  };

  const buildWorkflow = (): WorkflowDefinition => ({
    id: workflowId,
    name: workflowName,
    steps: flowToSteps(nodes, edges).map((s) => {
      if (s.id === selectedNodeId) {
        try {
          return { ...s, config: JSON.parse(configJson) as Record<string, unknown> };
        } catch {
          return s;
        }
      }
      return s;
    }),
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const wf = buildWorkflow();
      if (isNew) {
        const created = await workflowsApi.create(wf);
        navigate(`/workflows/${created.id}/edit`, { replace: true });
      } else {
        await workflowsApi.update(workflowId, wf);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!dagValidation.valid) return;
    setRunning(true);
    try {
      const wf = buildWorkflow();
      const { runId } = await runsApi.submit(wf, { traceId: `web-${Date.now()}` });
      navigate(`/runs/${runId}`);
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
        disabled={!dagValidation.valid || running}
        title={validationErrors.join('; ') || undefined}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-ctrl bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
      >
        <FontAwesomeIcon icon={faPlay} />
        运行
      </button>
    </>
  );

  return (
    <FullscreenLayout backTo="/workflows" backLabel="工作流" title={workflowName} actions={actions}>
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
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
            />
          </Field>
          <Field label="名称" htmlFor="workflow-name" className="mb-4">
            <Input
              id="workflow-name"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
            />
          </Field>

          <div className="flex gap-4 mb-4 text-sm items-center">
            <Checkbox
              id="fail-fast"
              checked={failFast}
              onCheckedChange={setFailFast}
              label="failFast"
            />
            <label className="flex items-center gap-2 text-muted">
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

          {selectedStep ? (
            <>
              <h3 className="text-xs font-medium text-faint uppercase tracking-wider mb-3 mt-6">
                步骤属性
              </h3>
              <Field label="步骤 ID" htmlFor="step-id">
                <Input
                  id="step-id"
                  mono
                  value={selectedStep.id}
                  onChange={(e) => updateSelected({ id: e.target.value })}
                />
              </Field>
              <Field label="名称" htmlFor="step-name">
                <Input
                  id="step-name"
                  value={selectedStep.name}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                />
              </Field>
              <Field label="插件" htmlFor="step-plugin">
                <Select
                  id="step-plugin"
                  value={selectedStep.plugin}
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
