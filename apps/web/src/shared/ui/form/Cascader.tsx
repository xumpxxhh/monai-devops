import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { useFieldId } from './field-context';
import { mergeClass, selectTriggerClass } from './form-styles';

export interface CascaderOption {
  value: string;
  label: string;
  /** 次要信息（如字段类型），仅在下拉项中展示 */
  typeLabel?: string;
  children?: CascaderOption[];
  disabled?: boolean;
}

export interface CascaderProps {
  value: string[];
  onValueChange: (value: string[]) => void;
  options: CascaderOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  id?: string;
  'aria-label'?: string;
  /**
   * 允许选中任意一级（含有子节点的中间项）。
   * 默认 true。
   */
  changeOnSelect?: boolean;
}

function findOptionPath(options: CascaderOption[], value: string[]): CascaderOption[] | null {
  if (value.length === 0) return [];
  const [head, ...rest] = value;
  const option = options.find((o) => o.value === head);
  if (!option) return null;
  if (rest.length === 0) return [option];
  const childPath = findOptionPath(option.children ?? [], rest);
  if (!childPath) return null;
  return [option, ...childPath];
}

function columnsForActivePath(options: CascaderOption[], activePath: string[]): CascaderOption[][] {
  const columns: CascaderOption[][] = [options];
  let current = options;
  for (const segment of activePath) {
    const next = current.find((o) => o.value === segment);
    if (!next?.children?.length) break;
    columns.push(next.children);
    current = next.children;
  }
  return columns;
}

export function Cascader({
  value,
  onValueChange,
  options,
  placeholder = '请选择…',
  disabled,
  className,
  triggerClassName,
  id,
  'aria-label': ariaLabel,
  changeOnSelect = true,
}: CascaderProps) {
  const fieldId = useFieldId();
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState<string[]>(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);

  const selectedOptions = useMemo(() => findOptionPath(options, value), [options, value]);
  const displayLabel =
    selectedOptions && selectedOptions.length > 0
      ? selectedOptions.map((o) => o.label).join(' / ')
      : null;

  const columns = useMemo(() => columnsForActivePath(options, activePath), [options, activePath]);

  // 打开时 / value 变化时同步高亮路径（渲染期调整 state，替代 effect 内 setState）
  const valueKey = value.join('\0');
  const [syncedOpenKey, setSyncedOpenKey] = useState<string | null>(null);
  if (open) {
    if (syncedOpenKey !== valueKey) {
      setSyncedOpenKey(valueKey);
      setActivePath(value);
    }
  } else if (syncedOpenKey !== null) {
    setSyncedOpenKey(null);
  }

  useEffect(() => {
    if (!open) return;

    const updatePos = () => {
      const el = rootRef.current;
      const panel = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8;
      const panelWidth = panel?.offsetWidth ?? 0;
      let left = rect.left;
      if (panelWidth > 0 && left + panelWidth > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - panelWidth - margin);
      }
      setPanelPos({
        top: rect.bottom + 4,
        left,
      });
    };
    updatePos();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    // 延迟注册，避免打开当次点击被误判为外部点击
    const frameId = requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onPointerDown);
    });

    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, columns.length]);

  // 层级加深时横向滚到最右列，避免新列被挡在视口外
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    requestAnimationFrame(() => {
      panel.scrollTo({ left: panel.scrollWidth, behavior: 'smooth' });
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8;
      const panelWidth = panel.offsetWidth;
      let left = rect.left;
      if (left + panelWidth > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - panelWidth - margin);
      }
      setPanelPos({ top: rect.bottom + 4, left });
    });
  }, [open, columns.length]);

  const selectAt = (path: string[], option: CascaderOption) => {
    const next = [...path, option.value];
    const hasChildren = Boolean(option.children?.length);
    if (hasChildren && !changeOnSelect) {
      setActivePath(next);
      return;
    }
    onValueChange(next);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={mergeClass('relative w-full', className)}>
      <button
        type="button"
        id={id ?? fieldId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        className={mergeClass(selectTriggerClass, 'w-full', triggerClassName)}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <span
          className={mergeClass('min-w-0 flex-1 truncate text-left', !displayLabel && 'text-faint')}
        >
          {displayLabel ?? placeholder}
        </span>
        <FontAwesomeIcon icon={faChevronDown} className="shrink-0 text-xs text-faint" />
      </button>

      {open &&
        panelPos &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            data-cascader-panel
            // Dialog 打开时 body 为 pointer-events:none；Portal 到 body 的面板必须显式恢复可点
            className="pointer-events-auto fixed z-[200] flex w-max max-w-[90vw] overflow-x-auto rounded-ctrl border border-line bg-surface shadow-pop"
            style={{ top: panelPos.top, left: panelPos.left }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {columns.map((column, depth) => (
              <ul
                key={depth}
                className="max-h-60 shrink-0 overflow-y-auto border-l border-line py-1 first:border-l-0"
              >
                {column.map((option) => {
                  const pathPrefix = activePath.slice(0, depth);
                  const optionPath = [...pathPrefix, option.value];
                  const isActive = activePath[depth] === option.value;
                  const isSelected =
                    value.length === optionPath.length &&
                    value.every((seg, i) => seg === optionPath[i]);
                  const hasChildren = Boolean(option.children?.length);

                  return (
                    <li key={option.value}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={option.disabled}
                        className={mergeClass(
                          'flex w-full cursor-pointer select-none items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-ink outline-none',
                          'hover:bg-brand-soft hover:text-brand',
                          'disabled:pointer-events-none disabled:opacity-50',
                          (isActive || isSelected) && 'bg-brand-soft text-brand',
                        )}
                        onMouseEnter={() => {
                          if (option.disabled) return;
                          setActivePath(optionPath);
                        }}
                        onClick={() => {
                          if (option.disabled) return;
                          selectAt(pathPrefix, option);
                        }}
                      >
                        <span className="w-3 shrink-0 text-brand">
                          {isSelected ? (
                            <FontAwesomeIcon icon={faCheck} className="text-xs" />
                          ) : null}
                        </span>
                        <span>{option.label}</span>
                        {option.typeLabel ? (
                          <span className="shrink-0 text-xs text-faint">{option.typeLabel}</span>
                        ) : null}
                        {hasChildren ? (
                          <FontAwesomeIcon
                            icon={faChevronRight}
                            className="shrink-0 text-xs text-faint"
                          />
                        ) : (
                          <span className="w-3 shrink-0" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
