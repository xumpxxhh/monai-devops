import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { getRunsWsUrl } from '../../config/env';
import type {
  SerializedWorkflowLifecycleEvent,
  WsInboundMessage,
  WsOutboundMessage,
  WorkflowRunResultSerialized,
} from '../types';

export type WsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RunListener {
  onEvent?: (event: SerializedWorkflowLifecycleEvent) => void;
  onDone?: (result: WorkflowRunResultSerialized) => void;
  onError?: (message: string) => void;
}

type StatusListener = (status: WsConnectionStatus) => void;

export class WorkflowRunClient {
  private ws: WebSocket | null = null;
  private status: WsConnectionStatus = 'disconnected';
  private readonly subscribedRunIds = new Set<string>();
  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly statusListeners = new Set<StatusListener>();
  private connectPromise: Promise<void> | null = null;

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: WsConnectionStatus) {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private hasListeners(): boolean {
    for (const set of this.listeners.values()) {
      if (set.size > 0) return true;
    }
    return false;
  }

  private ensureListenerSet(runId: string): Set<RunListener> {
    if (!this.listeners.has(runId)) {
      this.listeners.set(runId, new Set());
    }
    return this.listeners.get(runId)!;
  }

  private connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const url = getRunsWsUrl();
    if (!url) {
      return Promise.reject(new Error('未配置 DEVOPS_API_BASE_URL，无法建立 WebSocket 连接'));
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.setStatus('connecting');
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.setStatus('connected');
        this.connectPromise = null;
        resolve();
      };

      ws.onmessage = (ev) => {
        let message: WsOutboundMessage;
        try {
          message = JSON.parse(ev.data as string) as WsOutboundMessage;
        } catch {
          this.broadcastProtocolError('收到无法解析的服务端消息');
          return;
        }
        this.dispatchMessage(message);
      };

      ws.onerror = () => {
        this.setStatus('error');
        this.connectPromise = null;
        this.broadcastProtocolError('WebSocket 连接失败');
        reject(new Error('WebSocket 连接失败'));
      };

      ws.onclose = () => {
        this.ws = null;
        this.setStatus('disconnected');
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  private dispatchMessage(message: WsOutboundMessage): void {
    const runId =
      message.runId ?? (message.type === 'event' ? message.event.meta?.runId : undefined);

    if (!runId) {
      if (message.type === 'error') {
        this.broadcastProtocolError(message.message);
      }
      return;
    }

    if (message.type === 'event' && !this.subscribedRunIds.has(runId)) {
      this.subscribedRunIds.add(runId);
    }

    const runListeners = this.listeners.get(runId);
    if (!runListeners) return;

    for (const listener of runListeners) {
      if (message.type === 'event') {
        listener.onEvent?.(message.event);
      } else if (message.type === 'done') {
        listener.onDone?.(message.result);
      } else if (message.type === 'error') {
        listener.onError?.(message.message);
      }
    }
  }

  private broadcastProtocolError(message: string): void {
    for (const set of this.listeners.values()) {
      for (const listener of set) {
        listener.onError?.(message);
      }
    }
  }

  private send(message: WsInboundMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }
    ws.send(JSON.stringify(message));
  }

  private sendSubscribe(runId: string): void {
    if (this.subscribedRunIds.has(runId)) return;
    this.send({ type: 'subscribe', runId });
    this.subscribedRunIds.add(runId);
  }

  private sendUnsubscribe(runId: string): void {
    if (!this.subscribedRunIds.has(runId)) return;
    try {
      this.send({ type: 'unsubscribe', runId });
    } catch {
      // ignore if already closed
    }
    this.subscribedRunIds.delete(runId);
  }

  async subscribe(runId: string, listener: RunListener): Promise<void> {
    this.ensureListenerSet(runId).add(listener);
    await this.connect();
    this.sendSubscribe(runId);
  }

  unsubscribe(runId: string, listener: RunListener): void {
    const set = this.listeners.get(runId);
    if (!set) return;

    set.delete(listener);
    if (set.size === 0) {
      this.listeners.delete(runId);
      this.sendUnsubscribe(runId);
    }

    if (!this.hasListeners()) {
      this.close();
    }
  }

  async runWorkflow(workflow: WorkflowDefinition): Promise<void> {
    await this.connect();
    this.send({ type: 'run', workflow });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
    this.connectPromise = null;
    this.subscribedRunIds.clear();
  }
}

let sharedClient: WorkflowRunClient | null = null;

export function getSharedWorkflowRunClient(): WorkflowRunClient {
  if (!sharedClient) {
    sharedClient = new WorkflowRunClient();
  }
  return sharedClient;
}
