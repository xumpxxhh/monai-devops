import * as SelectPrimitive from '@radix-ui/react-select';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faCheck } from '@fortawesome/free-solid-svg-icons';
import { mergeClass, selectTriggerClass } from './form-styles';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  id?: string;
  'aria-label'?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = '请选择…',
  disabled,
  className,
  triggerClassName,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={mergeClass(selectTriggerClass, className, triggerClassName)}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-faint">
          <FontAwesomeIcon icon={faChevronDown} className="text-xs" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="z-50 overflow-hidden rounded-ctrl border border-line bg-surface shadow-pop"
          position="popper"
          sideOffset={4}
        >
          <SelectPrimitive.Viewport className="p-1 min-w-[var(--radix-select-trigger-width)]">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={mergeClass(
                  'relative flex cursor-pointer select-none items-center rounded-ctrl py-2 pl-8 pr-3 text-sm text-ink outline-none',
                  'data-[highlighted]:bg-brand-soft data-[highlighted]:text-brand',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2 flex items-center text-brand">
                  <FontAwesomeIcon icon={faCheck} className="text-xs" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
