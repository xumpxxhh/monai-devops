import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { getRunsWsUrl } from '../../config/env';
import type { WsInboundMessage, WsOutboundMessage } from '../types';

export type WsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WorkflowRunCallbacks {
  onOpen?: () => void;
  onEvent?: (event: WsOutboundMessage & { type: 'event' }) => void;
  onDone?: (result: unknown) => void;
  onError?: (message: string) => void;
  onStatusChange?: (status: WsConnectionStatus) => void;
}

export class WorkflowRunClient {
  private ws: WebSocket | null = null;
  private status: WsConnectionStatus = 'disconnected';
  private callbacks: WorkflowRunCallbacks = {};
  private busy = false;

  setCallbacks(callbacks: WorkflowRunCallbacks) {
    this.callbacks = callbacks;
  }

  getStatus(): WsConnectionStatus {
    return this.status;
  }

  isBusy(): boolean {
    return this.busy;
  }

  private setStatus(status: WsConnectionStatus) {
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }

  private connect(): WebSocket {
    const url = getRunsWsUrl();
    if (!url) {
      throw new Error('未配置 DEVOPS_API_BASE_URL，无法建立 WebSocket 连接');
    }
    this.setStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      this.callbacks.onOpen?.();
    };

    ws.onmessage = (ev) => {
      let message: WsOutboundMessage;
      try {
        message = JSON.parse(ev.data as string) as WsOutboundMessage;
      } catch {
        this.callbacks.onError?.('收到无法解析的服务端消息');
        return;
      }

      if (message.type === 'event') {
        this.callbacks.onEvent?.(message);
        return;
      }
      if (message.type === 'done') {
        this.busy = false;
        this.callbacks.onDone?.(message.result);
        return;
      }
      if (message.type === 'error') {
        this.busy = false;
        this.callbacks.onError?.(message.message);
      }
    };

    ws.onerror = () => {
      this.setStatus('error');
      this.busy = false;
      this.callbacks.onError?.('WebSocket 连接失败');
    };

    ws.onclose = () => {
      this.ws = null;
      this.setStatus('disconnected');
      this.busy = false;
    };

    return ws;
  }

  private send(message: WsInboundMessage) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }
    ws.send(JSON.stringify(message));
  }

  runWorkflow(workflow: WorkflowDefinition): Promise<void> {
    if (this.busy) {
      return Promise.reject(new Error('当前连接已有进行中的任务'));
    }
    this.busy = true;
    this.close();

    return new Promise((resolve, reject) => {
      const prevOnOpen = this.callbacks.onOpen;
      const prevOnError = this.callbacks.onError;

      this.callbacks.onOpen = () => {
        prevOnOpen?.();
        try {
          this.send({ type: 'run', workflow });
          resolve();
        } catch (e) {
          this.busy = false;
          reject(e);
        }
      };

      this.callbacks.onError = (msg) => {
        prevOnError?.(msg);
        if (this.status === 'error' || this.status === 'disconnected') {
          reject(new Error(msg));
        }
      };

      try {
        this.connect();
      } catch (e) {
        this.busy = false;
        reject(e);
      }
    });
  }

  subscribe(runId: string): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const prevOnOpen = this.callbacks.onOpen;
      this.callbacks.onOpen = () => {
        prevOnOpen?.();
        try {
          this.send({ type: 'subscribe', runId });
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      try {
        this.connect();
      } catch (e) {
        reject(e);
      }
    });
  }

  unsubscribe(runId: string) {
    try {
      this.send({ type: 'unsubscribe', runId });
    } catch {
      // ignore if already closed
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
    this.busy = false;
  }
}
