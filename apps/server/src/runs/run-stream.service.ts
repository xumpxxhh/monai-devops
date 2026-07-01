import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type {
  SerializedWorkflowLifecycleEvent,
  SerializedWorkflowRunResult,
} from '../common/serialization/serialize-workflow-event.js';

export type WsOutboundMessage =
  | { type: 'event'; event: SerializedWorkflowLifecycleEvent }
  | { type: 'done'; result: SerializedWorkflowRunResult }
  | { type: 'error'; message: string };

@Injectable()
export class RunStreamService {
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly clientRuns = new Map<WebSocket, Set<string>>();

  subscribe(runId: string, client: WebSocket, replay: SerializedWorkflowLifecycleEvent[]): void {
    if (!this.subscribers.has(runId)) {
      this.subscribers.set(runId, new Set());
    }
    this.subscribers.get(runId)!.add(client);

    if (!this.clientRuns.has(client)) {
      this.clientRuns.set(client, new Set());
    }
    this.clientRuns.get(client)!.add(runId);

    for (const event of replay) {
      this.send(client, { type: 'event', event });
    }
  }

  unsubscribe(runId: string, client: WebSocket): void {
    this.subscribers.get(runId)?.delete(client);
    this.clientRuns.get(client)?.delete(runId);
  }

  unsubscribeAll(client: WebSocket): void {
    const runIds = this.clientRuns.get(client);
    if (!runIds) return;

    for (const runId of runIds) {
      this.subscribers.get(runId)?.delete(client);
    }
    this.clientRuns.delete(client);
  }

  fanOut(runId: string, message: WsOutboundMessage): void {
    const clients = this.subscribers.get(runId);
    if (!clients) return;

    for (const client of clients) {
      this.send(client, message);
    }
  }

  send(client: WebSocket, message: WsOutboundMessage): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}
