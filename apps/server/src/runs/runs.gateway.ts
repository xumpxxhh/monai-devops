import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import type { WorkflowDefinition } from '@monai-devops/core-engine';
import { RunManagerService } from './run-manager.service.js';
import { RunStreamService } from './run-stream.service.js';

type WsInboundMessage =
  | { type: 'subscribe'; runId: string; fromEventIndex?: number }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'run'; workflow: WorkflowDefinition };

function getRunsWsPath(): string {
  const prefix = process.env.GLOBAL_API_PREFIX?.trim();
  return prefix ? `/${prefix}/runs/ws` : '/runs/ws';
}

@WebSocketGateway({ path: getRunsWsPath() })
export class RunsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RunsGateway.name);

  constructor(
    private readonly runManager: RunManagerService,
    private readonly runStream: RunStreamService,
  ) {}

  handleConnection(client: WebSocket): void {
    client.on('message', (raw) => {
      void this.handleMessage(client, raw);
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.runStream.unsubscribeAll(client);
  }

  private async handleMessage(client: WebSocket, raw: unknown): Promise<void> {
    let payload: unknown;
    try {
      const text = typeof raw === 'string' ? raw : raw?.toString();
      payload = JSON.parse(text ?? '');
    } catch {
      this.runStream.send(client, { type: 'error', message: '消息必须是合法 JSON' });
      return;
    }

    const message = payload as WsInboundMessage;
    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.runStream.send(client, { type: 'error', message: '消息格式无效' });
      return;
    }

    if (message.type === 'subscribe') {
      if (!message.runId?.trim()) {
        this.runStream.send(client, { type: 'error', message: 'subscribe 需要 runId' });
        return;
      }
      const fromEventIndex =
        typeof message.fromEventIndex === 'number' && Number.isFinite(message.fromEventIndex)
          ? Math.max(0, Math.floor(message.fromEventIndex))
          : 0;
      const result = await this.runManager.subscribeClientAsync(
        message.runId,
        client,
        fromEventIndex,
      );
      if (!result.ok) {
        this.runStream.send(client, { type: 'error', message: result.message });
      }
      return;
    }

    if (message.type === 'unsubscribe') {
      if (message.runId?.trim()) {
        this.runStream.unsubscribe(message.runId, client);
      }
      return;
    }

    if (message.type === 'run') {
      if (!message.workflow) {
        this.runStream.send(client, { type: 'error', message: 'run 需要 workflow 字段' });
        return;
      }

      try {
        const { runId } = await this.runManager.submitRun(message.workflow);
        const subscribed = await this.runManager.subscribeClientAsync(runId, client);
        if (!subscribed.ok) {
          this.runStream.send(client, { type: 'error', message: subscribed.message });
        }
      } catch (error: unknown) {
        const errMessage = error instanceof Error ? error.message : '受理 Run 失败';
        this.logger.error(errMessage, error instanceof Error ? error.stack : undefined);
        this.runStream.send(client, { type: 'error', message: errMessage });
      }
    }
  }
}
