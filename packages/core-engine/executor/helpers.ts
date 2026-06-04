/**
 * ExecutionResult 构建辅助函数
 * @module executor/helpers
 */

import { PluginFailureCodes, type PluginResult } from "@monai-devops/plugin-sdk";
import {
  StepFailureKinds,
  StepStatuses,
  type SkipReason,
  type StepFailureKind,
} from "../errors";
import type { ExecutionResult } from "./types";

export function buildCompletedResult(
  stepId: string,
  pluginResult: PluginResult,
): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.COMPLETED,
    success: true,
    pluginResult,
    result: pluginResult.data ?? pluginResult,
  };
}

export function buildSkippedResult(
  stepId: string,
  skipReason: SkipReason,
): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.SKIPPED,
    success: true,
    skipReason,
    result: { skipped: true, reason: skipReason },
  };
}

export interface FailedResultInput {
  pluginResult?: PluginResult;
  error: Error;
  failureKind: StepFailureKind;
}

export function buildFailedResult(
  stepId: string,
  input: FailedResultInput,
): ExecutionResult {
  return {
    stepId,
    status: StepStatuses.FAILED,
    success: false,
    pluginResult: input.pluginResult,
    error: input.error,
    failureKind: input.failureKind,
  };
}

export function pluginFailureKind(
  pluginResult: PluginResult,
): StepFailureKind {
  if (
    pluginResult.code === PluginFailureCodes.PLUGIN_NOT_FOUND ||
    pluginResult.code === PluginFailureCodes.PLUGIN_EXECUTION_ERROR
  ) {
    return StepFailureKinds.PLUGIN;
  }
  return StepFailureKinds.PLUGIN;
}
