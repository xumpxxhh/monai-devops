import {
  isWorkflowRefStep,
  validateDag,
  validateStepKinds,
  validateWorkflowContextReferences,
  validateWorkflowNesting,
  WorkflowValidationError,
  type ResolveWorkflow,
  type ValidateWorkflowContextReferencesOptions,
  type WorkflowDefinition,
} from '@monai-devops/core-engine';

export type ValidateWorkflowDefinitionOptions = ValidateWorkflowContextReferencesOptions & {
  /** 嵌套校验用；保存侧应注入查库 resolve */
  resolveWorkflow?: ResolveWorkflow;
  /** 本工作流已登记的 importId 集合；提供时校验 workflow 步骤引用一致性 */
  knownImportIds?: ReadonlySet<string>;
};

/**
 * 校验工作流定义：基础字段、step kinds、DAG、`$ref`、可选嵌套与 import 一致性。
 */
export async function validateWorkflowDefinition(
  workflow: WorkflowDefinition,
  options: ValidateWorkflowDefinitionOptions = {},
): Promise<void> {
  if (!workflow.id?.trim()) {
    throw new WorkflowValidationError('workflow.id 必须是非空字符串');
  }
  if (!workflow.name?.trim()) {
    throw new WorkflowValidationError('workflow.name 必须是非空字符串');
  }
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new WorkflowValidationError('workflow.steps 必须是非空数组');
  }

  const seenNames = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id?.trim() || !step.name?.trim()) {
      throw new WorkflowValidationError('每个 step 需要非空的 id、name');
    }
    const name = step.name.trim();
    if (seenNames.has(name)) {
      throw new WorkflowValidationError(`步骤名称「${name}」重复`);
    }
    seenNames.add(name);
  }

  validateStepKinds(workflow);
  validateDag(workflow.steps);
  validateWorkflowContextReferences(workflow, options);

  if (options.knownImportIds) {
    validateWorkflowImportConsistency(workflow, options.knownImportIds);
  }

  await validateWorkflowNesting(workflow, {
    resolveWorkflow: options.resolveWorkflow,
  });
}

/**
 * 每个 `kind: 'workflow'` 步骤的 `workflowRef.importId` 必须落在已知导入集合中。
 */
export function validateWorkflowImportConsistency(
  workflow: WorkflowDefinition,
  knownImportIds: ReadonlySet<string>,
): void {
  for (const step of workflow.steps) {
    if (!isWorkflowRefStep(step)) continue;
    const importId = step.workflowRef?.importId?.trim();
    if (!importId) {
      throw new WorkflowValidationError(`步骤 ${step.id} 缺少 workflowRef.importId`);
    }
    if (!knownImportIds.has(importId)) {
      throw new WorkflowValidationError(
        `步骤 ${step.id} 的 importId "${importId}" 不在本工作流的导入记录中`,
      );
    }
  }
}

/**
 * 收集定义中被引用的 importId，以及 stepId → importId 映射（供保存时同步清理）。
 */
export function collectWorkflowImportRefs(workflow: WorkflowDefinition): {
  importIds: Set<string>;
  stepIdByImportId: Map<string, string>;
} {
  const importIds = new Set<string>();
  const stepIdByImportId = new Map<string, string>();
  for (const step of workflow.steps) {
    if (!isWorkflowRefStep(step)) continue;
    const importId = step.workflowRef.importId.trim();
    importIds.add(importId);
    stepIdByImportId.set(importId, step.id);
  }
  return { importIds, stepIdByImportId };
}
