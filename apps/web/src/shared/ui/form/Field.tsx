import * as Label from '@radix-ui/react-label';
import { errorClass, hintClass, labelClass, mergeClass } from './form-styles';

interface FieldProps {
  label?: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** 表单项容器：Radix Label + 提示/错误文案 */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  return (
    <div className={mergeClass('mb-3', className)}>
      {label && (
        <Label.Root htmlFor={htmlFor} className={labelClass}>
          {label}
        </Label.Root>
      )}
      {children}
      {hint && !error && <p className={hintClass}>{hint}</p>}
      {error && <p className={errorClass}>{error}</p>}
    </div>
  );
}
