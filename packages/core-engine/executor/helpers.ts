/**
 * ExecutionResult 构建辅助函数
 * @module executor/helpers
 */

import { PluginFailureCodes, type PluginResult } from '@monai-devops/plugin-sdk';
import {
  ExecutionReasonCategories,
  StepFailureKinds,
  StepStatuses,
  SkipReasons,
  type SkipReason,
  type StepFailureKind,
} from '../errors.js';
import type { ExecutionResult } from './types.js';

export function buildCompletedResult(stepId: string, pluginResult: PluginResult): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.COMPLETED,
    success: true,
    pluginResult,
    result: pluginResult.data ?? pluginResult,
  };
}

export function buildSkippedResult(stepId: string, skipReason: SkipReason): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.SKIPPED,
    success: true,
    skipReason,
    reason: skipReasonToExecutionReason(skipReason),
    result: { skipped: true, reason: skipReason },
  };
}

export interface FailedResultInput {
  pluginResult?: PluginResult;
  error: Error;
  failureKind: StepFailureKind;
}

export function buildFailedResult(stepId: string, input: FailedResultInput): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.FAILED,
    success: false,
    pluginResult: input.pluginResult,
    error: input.error,
    failureKind: input.failureKind,
    reason: failureToExecutionReason(input.failureKind, input.error, input.pluginResult),
  };
}

function skipReasonToExecutionReason(skipReason: SkipReason) {
  const category =
    skipReason === SkipReasons.CONDITION_NOT_MET
      ? ExecutionReasonCategories.CONDITION
      : skipReason === SkipReasons.DEPENDENCY_FAILED
        ? ExecutionReasonCategories.DEPENDENCY
        : skipReason === SkipReasons.USER_CANCELLED
          ? ExecutionReasonCategories.CANCELLED
          : skipReason === SkipReasons.PAUSE_INTERRUPTED
            ? ExecutionReasonCategories.INTERRUPTED
            : ExecutionReasonCategories.POLICY;
  return { code: skipReason, category, retryable: false };
}

function failureToExecutionReason(
  failureKind: StepFailureKind,
  error: Error,
  pluginResult?: PluginResult,
) {
  const category =
    failureKind === StepFailureKinds.RESOURCE
      ? ExecutionReasonCategories.INFRASTRUCTURE
      : failureKind === StepFailureKinds.CONFIG_RESOLUTION
        ? ExecutionReasonCategories.CONFIGURATION
        : failureKind === StepFailureKinds.SUBWORKFLOW_FAILED
          ? ExecutionReasonCategories.DEPENDENCY
          : failureKind === StepFailureKinds.INTERNAL
            ? ExecutionReasonCategories.INTERNAL
            : ExecutionReasonCategories.BUSINESS;
  return {
    code: pluginResult?.code ?? failureKind,
    category,
    retryable:
      category === ExecutionReasonCategories.INFRASTRUCTURE ||
      category === ExecutionReasonCategories.INTERNAL,
    message: pluginResult?.message ?? error.message,
  };
}

/**
 * 将插件失败 Result 映射为步骤 failureKind。
 * PLUGIN_CANCELLED 由 executor 前置转为 SKIPPED，不会进入此函数。
 */
export function pluginFailureKind(pluginResult: PluginResult): StepFailureKind {
  switch (pluginResult.code) {
    case PluginFailureCodes.PLUGIN_NOT_FOUND:
    case PluginFailureCodes.PLUGIN_CONFIG_INVALID:
    case PluginFailureCodes.PLUGIN_EXECUTION_ERROR:
    default:
      return StepFailureKinds.PLUGIN;
  }
}
