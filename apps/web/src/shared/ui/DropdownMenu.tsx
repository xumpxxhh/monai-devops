import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { mergeClass } from './form/form-styles';

export interface DropdownMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface DropdownMenuProps {
  trigger: React.ReactNode;
  items: DropdownMenuItem[];
  align?: 'start' | 'center' | 'end';
  contentClassName?: string;
}

const itemClass =
  'flex cursor-pointer select-none items-center px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  contentClassName,
}: DropdownMenuProps) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className={mergeClass(
            'z-50 min-w-[120px] rounded-ctrl border border-line bg-surface py-1 shadow-pop',
            contentClassName,
          )}
          sideOffset={4}
          align={align}
        >
          {items.map((item) => (
            <DropdownMenuPrimitive.Item
              key={item.label}
              disabled={item.disabled}
              className={mergeClass(itemClass, item.destructive && 'text-failed')}
              onSelect={item.onSelect}
            >
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
