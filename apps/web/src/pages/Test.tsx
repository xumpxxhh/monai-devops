import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBaseUrl, getTestDevopsWsUrl } from '../config/env';
import '../App.css';

interface IntegrationTestResult {
  success: boolean;
  message: string;
  workflowId: string;
}

interface WorkflowDefinition {
  id: string;
  name: string;
  steps: Array<{
    id: string;
    name: string;
    plugin: string;
    config: Record<string, unknown>;
  }>;
}

interface LogEntry {
  id: number;
  timestamp: string;
  kind: 'event' | 'done' | 'error' | 'system';
  eventType?: string;
  payload: unknown;
}

type OutputMode = 'http' | 'websocket';

type TestState =
  | { status: 'idle' }
  | { status: 'loading'; outputMode: OutputMode; logs: LogEntry[]; ranAt: string }
  | { status: 'success'; outputMode: 'http'; data: IntegrationTestResult; ranAt: string }
  | { status: 'success'; outputMode: 'websocket'; logs: LogEntry[]; result: unknown; ranAt: string }
  | { status: 'error'; outputMode: 'http'; message: string; ranAt: string }
  | { status: 'error'; outputMode: 'websocket'; logs: LogEntry[]; message: string; ranAt: string };

type TestAction =
  | {
      id: string;
      label: string;
      description: string;
      mode: 'http';
      run: () => Promise<unknown>;
    }
  | {
      id: string;
      label: string;
      description: string;
      mode: 'websocket';
      workflow: WorkflowDefinition;
    };

type WsOutboundMessage =
  | { type: 'event'; event: { type?: string } & Record<string, unknown> }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };

const INTEGRATION_WORKFLOW: WorkflowDefinition = {
  id: 'integration-closed-loop',
  name: 'Core Engine Integration Test',
  steps: [
    {
      id: 'integration-step1',
      name: 'Integration Test',
      plugin: 'test-plugin',
      config: { type: 'unit' },
    },
    {
      id: 'integration-step2',
      name: 'Integration Test',
      plugin: 'test-plugin',
      config: { type: 'e2e' },
    },
    {
      id: 'integration-step3',
      name: 'Integration Test',
      plugin: 'test-plugin',
      config: { type: 'integration' },
    },
  ],
};

async function fetchIntegrationTest(): Promise<IntegrationTestResult> {
  const response = await fetch(`${apiBaseUrl}/test-devops`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<IntegrationTestResult>;
}

const TEST_ACTIONS: TestAction[] = [
  {
    id: 'integration',
    label: 'Core Engine 集成测试',
    description: 'HTTP 一次性返回最终结果',
    mode: 'http',
    run: fetchIntegrationTest,
  },
  {
    id: 'integration-ws',
    label: 'Core Engine 集成测试 (WebSocket)',
    description: '实时推送工作流执行日志',
    mode: 'websocket',
    workflow: INTEGRATION_WORKFLOW,
  },
];

function formatTimestamp(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false });
}

function createLogEntry(
  id: number,
  kind: LogEntry['kind'],
  payload: unknown,
  eventType?: string,
): LogEntry {
  return {
    id,
    timestamp: formatTimestamp(new Date()),
    kind,
    eventType,
    payload,
  };
}

function runWorkflowViaWebSocket(
  workflow: WorkflowDefinition,
  onLog: (entry: LogEntry) => void,
  wsRef: { current: WebSocket | null },
): Promise<unknown> {
  const wsUrl = getTestDevopsWsUrl();
  if (!wsUrl) {
    return Promise.reject(new Error('未配置 DEVOPS_API_BASE_URL，无法建立 WebSocket 连接'));
  }

  return new Promise((resolve, reject) => {
    let logId = 0;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const pushLog = (kind: LogEntry['kind'], payload: unknown, eventType?: string) => {
      onLog(createLogEntry(++logId, kind, payload, eventType));
    };

    ws.onopen = () => {
      pushLog('system', { message: 'WebSocket 已连接，正在发送工作流...' });
      ws.send(JSON.stringify({ type: 'run', workflow }));
    };

    ws.onmessage = (event) => {
      let message: WsOutboundMessage;
      try {
        message = JSON.parse(event.data as string) as WsOutboundMessage;
      } catch {
        reject(new Error('收到无法解析的服务端消息'));
        ws.close();
        return;
      }

      if (message.type === 'event') {
        pushLog('event', message.event, message.event.type);
        return;
      }

      if (message.type === 'done') {
        pushLog('done', message.result);
        ws.close();
        resolve(message.result);
        return;
      }

      if (message.type === 'error') {
        pushLog('error', { message: message.message });
        ws.close();
        reject(new Error(message.message));
      }
    };

    ws.onerror = () => {
      reject(new Error('WebSocket 连接失败'));
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  });
}

export default function Test() {
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => {
      const socket = wsRef.current;
      socket?.close();
    };
  }, []);

  const runTest = useCallback(async (action: TestAction) => {
    wsRef.current?.close();

    const ranAt = formatTimestamp(new Date());
    setActiveId(action.id);

    if (action.mode === 'http') {
      setState({ status: 'loading', outputMode: 'http', logs: [], ranAt });

      try {
        const data = await action.run();
        setState({
          status: 'success',
          outputMode: 'http',
          data: data as IntegrationTestResult,
          ranAt,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '请求失败';
        setState({ status: 'error', outputMode: 'http', message, ranAt });
      }
      return;
    }

    const logs: LogEntry[] = [];
    setState({ status: 'loading', outputMode: 'websocket', logs, ranAt });

    const appendLog = (entry: LogEntry) => {
      logs.push(entry);
      setState({ status: 'loading', outputMode: 'websocket', logs: [...logs], ranAt });
    };

    try {
      const result = await runWorkflowViaWebSocket(action.workflow, appendLog, wsRef);
      setState({ status: 'success', outputMode: 'websocket', logs: [...logs], result, ranAt });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '请求失败';
      setState({ status: 'error', outputMode: 'websocket', logs: [...logs], message, ranAt });
    }
  }, []);

  const isLoading = state.status === 'loading';
  const hasOutput = state.status !== 'idle';
  const isWebSocketOutput = hasOutput && state.outputMode === 'websocket';

  return (
    <section className="test-page">
      <header className="test-page-header">
        <h1>Core Engine 集成测试</h1>
        <p>从左侧选择测试项，在右侧查看响应结果或 WebSocket 实时日志</p>
      </header>

      <div className="test-page-body">
        <aside className="test-sidebar">
          <h2>测试列表</h2>
          <ul className="test-actions">
            {TEST_ACTIONS.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className={`test-action-btn${activeId === action.id ? ' is-active' : ''}`}
                  disabled={isLoading}
                  onClick={() => runTest(action)}
                >
                  <span className="test-action-label">{action.label}</span>
                  <span className="test-action-desc">{action.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="test-output">
          <div className="test-output-toolbar">
            <h2>响应输出</h2>
            {hasOutput && (
              <span className="test-output-time">
                {isWebSocketOutput ? '开始于' : '执行于'} {state.ranAt}
              </span>
            )}
          </div>

          <div className="test-output-panel">
            {state.status === 'idle' && (
              <p className="test-output-placeholder">点击左侧按钮开始测试</p>
            )}

            {state.status === 'loading' && state.outputMode === 'http' && (
              <p className="test-output-loading">运行中...</p>
            )}

            {state.status === 'loading' && state.outputMode === 'websocket' && (
              <div className="test-log-stream">
                <ul className="test-log-list">
                  {state.logs.map((log) => (
                    <li key={log.id} className={`test-log-entry test-log-entry--${log.kind}`}>
                      <div className="test-log-meta">
                        <span className="test-log-time">{log.timestamp}</span>
                        <span className="test-log-badge">{log.eventType ?? log.kind}</span>
                      </div>
                      <pre className="test-log-body">
                        <code>{JSON.stringify(log.payload, null, 2)}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
                <p className="test-output-loading test-log-stream-status">运行中...</p>
              </div>
            )}

            {state.status === 'error' && state.outputMode === 'http' && (
              <pre className="test-output-error">
                <code>{JSON.stringify({ error: state.message }, null, 2)}</code>
              </pre>
            )}

            {state.status === 'success' && state.outputMode === 'http' && (
              <pre
                className={`test-output-json${state.data.success ? ' is-success' : ' is-failure'}`}
              >
                <code>{JSON.stringify(state.data, null, 2)}</code>
              </pre>
            )}

            {state.status === 'error' && state.outputMode === 'websocket' && (
              <div className="test-log-stream">
                <ul className="test-log-list">
                  {state.logs.map((log) => (
                    <li key={log.id} className={`test-log-entry test-log-entry--${log.kind}`}>
                      <div className="test-log-meta">
                        <span className="test-log-time">{log.timestamp}</span>
                        <span className="test-log-badge">{log.eventType ?? log.kind}</span>
                      </div>
                      <pre className="test-log-body">
                        <code>{JSON.stringify(log.payload, null, 2)}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
                <pre className="test-output-error test-log-final">
                  <code>{JSON.stringify({ error: state.message }, null, 2)}</code>
                </pre>
              </div>
            )}

            {state.status === 'success' && state.outputMode === 'websocket' && (
              <div className="test-log-stream">
                <ul className="test-log-list">
                  {state.logs.map((log) => (
                    <li key={log.id} className={`test-log-entry test-log-entry--${log.kind}`}>
                      <div className="test-log-meta">
                        <span className="test-log-time">{log.timestamp}</span>
                        <span className="test-log-badge">{log.eventType ?? log.kind}</span>
                      </div>
                      <pre className="test-log-body">
                        <code>{JSON.stringify(log.payload, null, 2)}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
                <pre className="test-output-json is-success test-log-final">
                  <code>{JSON.stringify(state.result, null, 2)}</code>
                </pre>
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  );
}
