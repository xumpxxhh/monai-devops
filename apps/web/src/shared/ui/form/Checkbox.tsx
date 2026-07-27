import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { useFieldId } from './field-context';
import { mergeClass } from './form-styles';

export interface CheckboxProps {
  id?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  className?: string;
}

export function Checkbox({
  id,
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
}: CheckboxProps) {
  const fieldId = useFieldId();
  const resolvedId = id ?? fieldId;

  return (
    <label
      htmlFor={resolvedId}
      className={mergeClass(
        'inline-flex items-center gap-2 text-sm text-muted cursor-pointer select-none',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <CheckboxPrimitive.Root
        id={resolvedId}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange?.(v === true)}
        disabled={disabled}
        className={mergeClass(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line bg-panel',
          'transition-colors hover:border-brand/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
          'data-[state=checked]:bg-brand data-[state=checked]:border-brand data-[state=checked]:text-white',
        )}
      >
        <CheckboxPrimitive.Indicator>
          <FontAwesomeIcon icon={faCheck} className="text-[10px]" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label !== undefined && <span>{label}</span>}
    </label>
  );
}
