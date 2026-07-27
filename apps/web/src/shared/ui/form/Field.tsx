import { useId } from 'react';
import * as Label from '@radix-ui/react-label';
import { FieldIdProvider } from './field-context';
import { errorClass, hintClass, labelClass, mergeClass } from './form-styles';

interface FieldProps {
  label?: string;
  /** 显式指定控件 id；未传时由 Field 自动生成并注入子控件 */
  id?: string;
  /** @deprecated 请使用 id；保留以兼容旧写法 */
  htmlFor?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** 表单项容器：Radix Label + 提示/错误文案，自动关联子表单控件 */
export function Field({ label, id, htmlFor, hint, error, className, children }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? htmlFor ?? generatedId;

  return (
    <FieldIdProvider value={fieldId}>
      <div className={mergeClass('mb-3', className)}>
        {label && (
          <Label.Root htmlFor={fieldId} className={labelClass}>
            {label}
          </Label.Root>
        )}
        {children}
        {hint && !error && <p className={hintClass}>{hint}</p>}
        {error && <p className={errorClass}>{error}</p>}
      </div>
    </FieldIdProvider>
  );
}
