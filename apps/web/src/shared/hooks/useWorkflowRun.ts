import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import {
  getSharedWorkflowRunClient,
  type RunListener,
  type WsConnectionStatus,
} from '../api/workflow-run-client';
import type { SerializedWorkflowLifecycleEvent, WorkflowRunResultSerialized } from '../types';

export interface UseWorkflowRunOptions {
  runId?: string;
  /** 为 false 时不自动订阅 runId（默认 true，需同时提供 runId） */
  autoSubscribe?: boolean;
  onEvent?: (event: SerializedWorkflowLifecycleEvent) => void;
  onDone?: (result: WorkflowRunResultSerialized) => void;
  onError?: (message: string) => void;
}

export function useWorkflowRun(options: UseWorkflowRunOptions = {}) {
  const { runId, autoSubscribe = true } = options;
  const client = getSharedWorkflowRunClient();
  const [status, setStatus] = useState<WsConnectionStatus>(client.getStatus());
  const optionsRef = useRef(options);
  const listenerRef = useRef<RunListener | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    return client.onStatusChange(setStatus);
  }, [client]);

  useEffect(() => {
    if (!runId || !autoSubscribe) return;

    const listener: RunListener = {
      onEvent: (event) => optionsRef.current.onEvent?.(event),
      onDone: (result) => optionsRef.current.onDone?.(result),
      onError: (msg) => optionsRef.current.onError?.(msg),
    };
    listenerRef.current = listener;

    client.subscribe(runId, listener).catch((e) => {
      optionsRef.current.onError?.(e instanceof Error ? e.message : 'WebSocket 订阅失败');
    });

    return () => {
      client.unsubscribe(runId, listener);
      listenerRef.current = null;
    };
  }, [client, runId, autoSubscribe]);

  const runWorkflow = useCallback(
    async (workflow: WorkflowDefinition) => {
      await client.runWorkflow(workflow);
    },
    [client],
  );

  const subscribe = useCallback(
    async (runId: string) => {
      const listener: RunListener = {
        onEvent: (event) => optionsRef.current.onEvent?.(event),
        onDone: (result) => optionsRef.current.onDone?.(result),
        onError: (msg) => optionsRef.current.onError?.(msg),
      };
      listenerRef.current = listener;
      await client.subscribe(runId, listener);
    },
    [client],
  );

  const unsubscribe = useCallback(
    (runId: string) => {
      if (listenerRef.current) {
        client.unsubscribe(runId, listenerRef.current);
        listenerRef.current = null;
      }
    },
    [client],
  );

  const close = useCallback(() => {
    client.close();
  }, [client]);

  return { status, runWorkflow, subscribe, unsubscribe, close };
}
