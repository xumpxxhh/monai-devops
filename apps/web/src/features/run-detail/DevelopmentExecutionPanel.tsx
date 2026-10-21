import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../shared/api/http';
import { runsApi } from '../../shared/api/runs';
import type { DevelopmentAttempt, DevelopmentObject } from '../../shared/types';

function collectObjectIds(value: unknown, ids = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || !value || typeof value !== 'object') return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectIds(item, ids, depth + 1);
    return ids;
  }
  const object = value as Record<string, unknown>;
  if (
    object.objectRef &&
    typeof object.objectRef === 'object' &&
    typeof (object.objectRef as Record<string, unknown>).objectId === 'string'
  ) {
    ids.add((object.objectRef as { objectId: string }).objectId);
  }
  for (const child of Object.values(object)) collectObjectIds(child, ids, depth + 1);
  return ids;
}

function decodeObject(object: DevelopmentObject): string {
  const bytes = Uint8Array.from(atob(object.bodyBase64), (char) => char.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  if (object.objectRef.contentType !== 'application/json') return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function DevelopmentExecutionPanel({
  runId,
  stepId,
  stepResult,
}: {
  runId: string;
  stepId: string;
  stepResult: unknown;
}) {
  const [attempts, setAttempts] = useState<DevelopmentAttempt[]>([]);
  const [available, setAvailable] = useState(true);
  const [payload, setPayload] = useState('{}');
  const [busyAttempt, setBusyAttempt] = useState('');
  const [objectContent, setObjectContent] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await runsApi.getExecution(runId);
        if (!cancelled) setAttempts(response.attempts);
      } catch (error) {
        if (!cancelled && error instanceof ApiError && error.status === 404) {
          setAvailable(false);
          window.clearInterval(timer);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId]);

  const stepAttempts = attempts.filter((attempt) => attempt.stepId === stepId);
  const objectIds = useMemo(() => {
    const ids = collectObjectIds(stepResult);
    for (const attempt of stepAttempts) collectObjectIds(attempt.result, ids);
    return [...ids];
  }, [stepResult, stepAttempts]);

  if (!available) return null;

  const signal = async (attempt: DevelopmentAttempt) => {
    if (!attempt.wakeKey) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      toast.error('唤醒 Payload 必须是有效 JSON');
      return;
    }
    setBusyAttempt(attempt.attemptId);
    try {
      await runsApi.signalWait(runId, attempt.attemptId, attempt.wakeKey, parsed);
      toast.success('唤醒信号已接受');
      const response = await runsApi.getExecution(runId);
      setAttempts(response.attempts);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '唤醒失败');
    } finally {
      setBusyAttempt('');
    }
  };

  const showObject = async (objectId: string) => {
    try {
      const object = await runsApi.getObject(runId, objectId);
      setObjectContent((current) => ({ ...current, [objectId]: decodeObject(object) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '对象读取失败');
    }
  };

  return (
    <section className="border-t border-line pt-3 space-y-3">
      <h3 className="text-xs font-medium text-faint uppercase tracking-wider">
        执行 Attempt（本地开发）
      </h3>
      {stepAttempts.length === 0 && <p className="text-xs text-muted">尚无持久化 Attempt</p>}
      {stepAttempts.map((attempt) => (
        <div
          key={attempt.attemptId}
          className="rounded-ctrl border border-line p-3 space-y-2 text-xs"
        >
          <div className="flex justify-between gap-2">
            <span>
              #{attempt.attempt} · {attempt.remote ? '远程 Worker' : '本地'} · {attempt.status}
            </span>
            <span className="font-mono text-faint">{attempt.attemptId.slice(0, 8)}</span>
          </div>
          {attempt.workerId && <div className="text-muted">Worker: {attempt.workerId}</div>}
          {attempt.reason != null && (
            <pre className="bg-panel p-2 overflow-auto max-h-28">
              {JSON.stringify(attempt.reason, null, 2)}
            </pre>
          )}
          {attempt.status === 'waiting' && attempt.wakeKey && (
            <div className="space-y-2">
              <div>
                等待 {attempt.waitKind ?? 'signal'} · Key: <code>{attempt.wakeKey}</code>
              </div>
              <textarea
                aria-label="唤醒 Payload JSON"
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                className="w-full bg-panel border border-line rounded-ctrl p-2 font-mono min-h-16"
              />
              <button
                type="button"
                disabled={!!busyAttempt}
                onClick={() => void signal(attempt)}
                className="h-8 px-3 rounded-ctrl border border-line hover:bg-raised disabled:opacity-60"
              >
                发送唤醒信号
              </button>
            </div>
          )}
        </div>
      ))}
      {objectIds.map((objectId) => (
        <div key={objectId} className="space-y-1">
          <button
            type="button"
            onClick={() => void showObject(objectId)}
            className="text-brand text-xs hover:underline"
          >
            查看对象 {objectId.slice(0, 8)}…
          </button>
          {objectContent[objectId] !== undefined && (
            <pre className="bg-panel p-2 text-xs overflow-auto max-h-64">
              {objectContent[objectId]}
            </pre>
          )}
        </div>
      ))}
    </section>
  );
}
