import { useState } from 'react';
import type { RetryPolicy } from '@monai-devops/core-engine';
import { Checkbox, Field, Input, Textarea } from '../../shared/ui/form';
import { parseSecretRefLines } from './secret-ref-lines';

export interface ExecutorSettingsValue {
  retryPolicy?: RetryPolicy;
  mayWait?: boolean;
  requestedCapabilities?: string[];
  secretRefs?: Record<string, string>;
}

export function ExecutorSettingsPanel({
  value,
  onUpdate,
}: {
  value: ExecutorSettingsValue;
  onUpdate: (patch: Partial<ExecutorSettingsValue>) => void;
}) {
  const [secretDraft, setSecretDraft] = useState(() =>
    Object.entries(value.secretRefs ?? {})
      .map(([alias, ref]) => `${alias}=${ref}`)
      .join('\n'),
  );
  const [secretError, setSecretError] = useState('');
  const [capabilityDraft, setCapabilityDraft] = useState(() =>
    (value.requestedCapabilities ?? []).join(', '),
  );

  const retry = value.retryPolicy ?? { maxAttempts: 1, backoffMs: 0 };
  const setRetry = (patch: Partial<RetryPolicy>) =>
    onUpdate({ retryPolicy: { ...retry, ...patch } });

  return (
    <section className="mt-4 pt-4 border-t border-line space-y-3">
      <h4 className="text-xs font-medium text-faint uppercase tracking-wider">执行设置</h4>
      <Checkbox
        checked={value.mayWait === true}
        onCheckedChange={(checked) =>
          onUpdate({
            mayWait: checked,
            ...(checked && retry.maxAttempts < 2
              ? { retryPolicy: { ...retry, maxAttempts: 2, backoffMs: retry.backoffMs || 100 } }
              : {}),
          })
        }
        label="允许持久化等待"
      />
      <Field label="最多尝试次数">
        <Input
          type="number"
          min={value.mayWait ? 2 : 1}
          max={100}
          value={retry.maxAttempts}
          onChange={(event) => {
            const number = Number(event.target.value);
            if (Number.isInteger(number) && number >= (value.mayWait ? 2 : 1)) {
              setRetry({ maxAttempts: number });
            }
          }}
        />
      </Field>
      <Field label="重试退避（毫秒）">
        <Input
          type="number"
          min={0}
          value={retry.backoffMs}
          onChange={(event) => {
            const number = Number(event.target.value);
            if (Number.isInteger(number) && number >= 0) setRetry({ backoffMs: number });
          }}
        />
      </Field>
      <Field label="请求的 Capability（逗号分隔）">
        <Input
          value={capabilityDraft}
          onChange={(event) => setCapabilityDraft(event.target.value)}
          onBlur={() =>
            onUpdate({
              requestedCapabilities: [
                ...new Set(
                  capabilityDraft
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                ),
              ],
            })
          }
          placeholder="execution.wait, secret.read"
        />
      </Field>
      <Field label="Secret 引用（每行 alias=secret://env/NAME）">
        <Textarea
          rows={3}
          value={secretDraft}
          onChange={(event) => setSecretDraft(event.target.value)}
          placeholder="apiKey=secret://env/MY_API_KEY"
        />
      </Field>
      {secretError && <p className="text-xs text-failed">{secretError}</p>}
      <button
        type="button"
        onClick={() => {
          try {
            const refs = parseSecretRefLines(secretDraft);
            onUpdate({ secretRefs: Object.keys(refs).length ? refs : undefined });
            setSecretError('');
          } catch (error) {
            setSecretError(error instanceof Error ? error.message : 'Secret 引用无效');
          }
        }}
        className="h-8 px-3 rounded-ctrl border border-line text-xs hover:bg-raised"
      >
        应用 Secret 引用
      </button>
      <p className="text-xs text-faint">
        权限仍由插件声明、server 环境策略和 Worker 报价共同决定。
      </p>
    </section>
  );
}
