import {
  getStepKind,
  isContextRef,
  isPluginStep,
  isSetStateStep,
  isWorkflowRefStep,
  StepKinds,
  WORKFLOW_STATE_REF_ID,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@monai-devops/core-engine';
import type { WorkflowDraft, WorkflowDraftStep } from '../../shared/api/workflows';

export class WorkflowJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowJsonParseError';
  }
}

export interface DefinitionToDraftResult {
  draft: WorkflowDraft;
  skippedWorkflowStepCount: number;
}

export interface ImportPreview {
  definition: WorkflowDefinition;
  defaultName: string;
  stepCount: number;
  skippedWorkflowStepCount: number;
  missingPlugins: string[];
}

/**
 * 将对象树中 `$ref.fromStepId` 经 refByStepId 重写为 clientRef（与 dependsOn 一致）。
 * `__workflow_state__` 保留；未知 id 原样保留（交由服务端报错）。
 */
function remapContextReferences(value: unknown, refByStepId: Map<string, string>): unknown {
  if (isContextRef(value)) {
    const { fromStepId, path } = value.$ref;
    if (fromStepId === WORKFLOW_STATE_REF_ID) {
      return { $ref: { fromStepId: WORKFLOW_STATE_REF_ID, path: [...path] } };
    }
    return {
      $ref: {
        fromStepId: refByStepId.get(fromStepId) ?? fromStepId,
        path: [...path],
      },
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => remapContextReferences(item, refByStepId));
  }

  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = remapContextReferences(nested, refByStepId);
    }
    return out;
  }

  return value;
}

function cloneStepToDraft(
  step: WorkflowStep,
  clientRef: string,
  refByStepId: Map<string, string>,
): WorkflowDraftStep | null {
  const base = {
    clientRef,
    name: step.name,
    dependsOn: step.dependsOn?.map((dep) => refByStepId.get(dep) ?? dep),
    priority: step.priority,
    condition: step.condition,
  };

  if (isSetStateStep(step)) {
    return {
      ...base,
      kind: StepKinds.SET_STATE,
      patch: remapContextReferences(structuredClone(step.patch), refByStepId) as Record<
        string,
        unknown
      >,
    };
  }
  if (isWorkflowRefStep(step)) {
    return null;
  }
  if (isPluginStep(step)) {
    return {
      ...base,
      kind: StepKinds.PLUGIN,
      plugin: step.plugin,
      config: remapContextReferences(structuredClone(step.config), refByStepId) as Record<
        string,
        unknown
      >,
    };
  }
  return {
    ...base,
    kind: StepKinds.PLUGIN,
    plugin: '',
    config: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isRecord(value)) {
    throw new WorkflowJsonParseError('JSON 根节点必须是对象');
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new WorkflowJsonParseError('缺少有效的 name 字段');
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw new WorkflowJsonParseError('steps 必须是非空数组');
  }

  for (let i = 0; i < value.steps.length; i += 1) {
    const step = value.steps[i];
    if (!isRecord(step) || typeof step.name !== 'string' || !step.name.trim()) {
      throw new WorkflowJsonParseError(`steps[${i}] 缺少有效的 name 字段`);
    }
  }

  return value as unknown as WorkflowDefinition;
}

export function parseWorkflowJson(text: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkflowJsonParseError('JSON 格式无效');
  }
  return assertWorkflowDefinition(parsed);
}

export function collectMissingPlugins(
  definition: WorkflowDefinition,
  registeredPluginNames: ReadonlySet<string>,
): string[] {
  const missing = new Set<string>();
  for (const step of definition.steps) {
    if (getStepKind(step) !== StepKinds.PLUGIN) continue;
    if (!isPluginStep(step)) continue;
    const plugin = step.plugin?.trim();
    if (!plugin) {
      missing.add('(未指定插件)');
      continue;
    }
    if (!registeredPluginNames.has(plugin)) {
      missing.add(plugin);
    }
  }
  return [...missing];
}

export function suggestImportName(
  originalName: string,
  existingNames: ReadonlySet<string>,
): string {
  const trimmed = originalName.trim();
  if (!existingNames.has(trimmed)) {
    return trimmed;
  }
  const withSuffix = `${trimmed} (导入)`;
  if (!existingNames.has(withSuffix)) {
    return withSuffix;
  }
  return `${trimmed} (导入 ${crypto.randomUUID().slice(0, 6)})`;
}

export function buildImportPreview(
  definition: WorkflowDefinition,
  registeredPluginNames: ReadonlySet<string>,
  existingNames: ReadonlySet<string>,
): ImportPreview {
  const { draft, skippedWorkflowStepCount } = definitionToDraft(definition);
  return {
    definition,
    defaultName: suggestImportName(definition.name, existingNames),
    stepCount: draft.steps.length,
    skippedWorkflowStepCount,
    missingPlugins: collectMissingPlugins(definition, registeredPluginNames),
  };
}

export function definitionToDraft(definition: WorkflowDefinition): DefinitionToDraftResult {
  const refByStepId = new Map(definition.steps.map((step, i) => [step.id, `copy-${i}`]));
  const steps = definition.steps
    .map((step, i) => cloneStepToDraft(step, `copy-${i}`, refByStepId))
    .filter((step): step is WorkflowDraftStep => step !== null);

  const skippedWorkflowStepCount = definition.steps.filter(
    (step) => getStepKind(step) === StepKinds.WORKFLOW,
  ).length;

  const draft: WorkflowDraft = {
    name: definition.name.trim(),
    ...(definition.stateSchema
      ? { stateSchema: structuredClone(definition.stateSchema) as Record<string, unknown> }
      : {}),
    steps,
  };

  return { draft, skippedWorkflowStepCount };
}
