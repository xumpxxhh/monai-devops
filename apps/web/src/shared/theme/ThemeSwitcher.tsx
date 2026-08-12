import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { applyTheme, readStoredTheme, THEMES, type ThemeId } from './theme';

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const current = THEMES.find((item) => item.id === theme) ?? THEMES[0];

  const selectTheme = (next: ThemeId) => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className="relative z-10 isolate inline-flex items-center gap-2 h-8 px-2.5 rounded-ctrl bg-raised border border-line text-xs text-muted hover:text-ink hover:border-faint/40 transition-colors outline-none"
          aria-label={`主题色：${current.label}`}
          title="切换主题色"
        >
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
            style={{ backgroundColor: current.swatch }}
          />
          <span className="font-medium text-ink">{current.label}</span>
          <FontAwesomeIcon icon={faChevronDown} className="text-[10px] text-faint" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className="z-50 min-w-[140px] rounded-ctrl border border-line bg-surface py-1 shadow-pop"
          sideOffset={6}
          align="end"
        >
          {THEMES.map((item) => {
            const selected = theme === item.id;
            return (
              <DropdownMenuPrimitive.Item
                key={item.id}
                className={`flex cursor-pointer select-none items-center gap-2.5 px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-raised ${
                  selected ? 'text-brand font-medium' : 'text-ink'
                }`}
                onSelect={() => selectTheme(item.id)}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0 border border-line"
                  style={{ backgroundColor: item.swatch }}
                />
                {item.label}
                {selected ? <span className="ml-auto text-xs text-faint">当前</span> : null}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
