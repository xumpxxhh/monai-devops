import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { WorkflowRunClient, type WsConnectionStatus } from '../api/workflow-run-client';
import type { SerializedWorkflowLifecycleEvent, WorkflowRunResultSerialized } from '../types';

export interface UseWorkflowRunOptions {
  onEvent?: (event: SerializedWorkflowLifecycleEvent) => void;
  onDone?: (result: WorkflowRunResultSerialized) => void;
  onError?: (message: string) => void;
}

export function useWorkflowRun(options: UseWorkflowRunOptions = {}) {
  const clientRef = useRef<WorkflowRunClient | null>(null);
  const [status, setStatus] = useState<WsConnectionStatus>('disconnected');
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const client = new WorkflowRunClient();
    client.setCallbacks({
      onStatusChange: setStatus,
      onEvent: (msg) => optionsRef.current.onEvent?.(msg.event),
      onDone: (result) => optionsRef.current.onDone?.(result as WorkflowRunResultSerialized),
      onError: (msg) => optionsRef.current.onError?.(msg),
    });
    clientRef.current = client;
    return () => client.close();
  }, []);

  const runWorkflow = useCallback(async (workflow: WorkflowDefinition) => {
    await clientRef.current?.runWorkflow(workflow);
  }, []);

  const subscribe = useCallback(async (runId: string) => {
    await clientRef.current?.subscribe(runId);
  }, []);

  const unsubscribe = useCallback((runId: string) => {
    clientRef.current?.unsubscribe(runId);
  }, []);

  const close = useCallback(() => {
    clientRef.current?.close();
  }, []);

  return { status, runWorkflow, subscribe, unsubscribe, close };
}
