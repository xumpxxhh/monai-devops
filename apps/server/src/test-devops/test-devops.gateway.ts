import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { TestDevopsService } from './test-devops.service.js';
import { serializeWorkflowEvent, serializeWorkflowRunResult } from './serialize-workflow-event.js';
import { parseRunWorkflowMessage } from './validate-workflow-payload.js';

interface ClientSession {
  running: boolean;
  destroy: (() => void) | null;
}

type OutboundMessage =
  | { type: 'event'; event: ReturnType<typeof serializeWorkflowEvent> }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };

function getTestDevopsWsPath(): string {
  const prefix = process.env.GLOBAL_API_PREFIX?.trim();
  return prefix ? `/${prefix}/test-devops/ws` : '/test-devops/ws';
}

@WebSocketGateway({ path: getTestDevopsWsPath() })
export class TestDevopsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TestDevopsGateway.name);
  private readonly sessions = new Map<WebSocket, ClientSession>();

  constructor(private readonly testDevopsService: TestDevopsService) {}

  handleConnection(client: WebSocket): void {
    this.sessions.set(client, { running: false, destroy: null });

    client.on('message', (raw) => {
      void this.handleMessage(client, raw);
    });
  }

  handleDisconnect(client: WebSocket): void {
    const session = this.sessions.get(client);
    session?.destroy?.();
    this.sessions.delete(client);
  }

  private send(client: WebSocket, message: OutboundMessage): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  private async handleMessage(client: WebSocket, raw: unknown): Promise<void> {
    const session = this.sessions.get(client);
    if (!session) return;

    if (session.running) {
      this.send(client, { type: 'error', message: '当前连接已有工作流在执行中' });
      return;
    }

    let payload: unknown;
    try {
      const text = typeof raw === 'string' ? raw : raw?.toString();
      payload = JSON.parse(text ?? '');
    } catch {
      this.send(client, { type: 'error', message: '消息必须是合法 JSON' });
      return;
    }

    const parsed = parseRunWorkflowMessage(payload);
    if (!parsed.ok) {
      this.send(client, { type: 'error', message: parsed.message });
      return;
    }

    session.running = true;

    const { result, destroy } = this.testDevopsService.runWorkflowWithObserver(
      parsed.workflow,
      async (event) => {
        this.send(client, { type: 'event', event: serializeWorkflowEvent(event) });
      },
    );

    session.destroy = destroy;

    try {
      const runResult = await result;
      this.send(client, { type: 'done', result: serializeWorkflowRunResult(runResult) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '工作流执行失败';
      this.logger.error(message, error instanceof Error ? error.stack : undefined);
      this.send(client, { type: 'error', message });
    } finally {
      session.running = false;
      session.destroy = null;
    }
  }
}
