import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { RunManagerService } from '../runs/run-manager.service.js';
import { RunStreamService } from '../runs/run-stream.service.js';
import { parseRunWorkflowMessage } from './validate-workflow-payload.js';

function getTestDevopsWsPath(): string {
  const prefix = process.env.GLOBAL_API_PREFIX?.trim();
  return prefix ? `/${prefix}/test-devops/ws` : '/test-devops/ws';
}

@WebSocketGateway({ path: getTestDevopsWsPath() })
export class TestDevopsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TestDevopsGateway.name);

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

    const parsed = parseRunWorkflowMessage(payload);
    if (!parsed.ok) {
      this.runStream.send(client, { type: 'error', message: parsed.message });
      return;
    }

    try {
      const { runId } = await this.runManager.submitRun(parsed.workflow);
      const subscribed = await this.runManager.subscribeClientAsync(runId, client);
      if (!subscribed.ok) {
        this.runStream.send(client, { type: 'error', message: subscribed.message });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '工作流执行失败';
      this.logger.error(message, error instanceof Error ? error.stack : undefined);
      this.runStream.send(client, { type: 'error', message });
    }
  }
}
