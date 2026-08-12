import * as SwitchPrimitive from '@radix-ui/react-switch';
import { useFieldId } from './field-context';
import { mergeClass } from './form-styles';

export interface SwitchProps {
  id?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  className?: string;
}

export function Switch({ id, checked, onCheckedChange, disabled, label, className }: SwitchProps) {
  const fieldId = useFieldId();
  const resolvedId = id ?? fieldId;

  const control = (
    <SwitchPrimitive.Root
      id={resolvedId}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={mergeClass(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line bg-panel',
        'transition-colors hover:border-brand/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-brand data-[state=checked]:border-brand',
      )}
    >
      <SwitchPrimitive.Thumb
        className={mergeClass(
          'pointer-events-none block h-3.5 w-3.5 rounded-full bg-muted shadow-sm',
          'transition-transform translate-x-0.5',
          'data-[state=checked]:translate-x-[1.125rem] data-[state=checked]:bg-white',
        )}
      />
    </SwitchPrimitive.Root>
  );

  if (label === undefined) {
    return <span className={className}>{control}</span>;
  }

  return (
    <label
      htmlFor={resolvedId}
      className={mergeClass(
        'inline-flex w-full items-center justify-between gap-3 text-sm text-muted cursor-pointer select-none',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span>{label}</span>
      {control}
    </label>
  );
}
