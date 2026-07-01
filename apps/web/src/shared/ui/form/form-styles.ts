/** 表单控件共享样式（Control Room 主题） */
export const controlBaseClass =
  'w-full rounded-ctrl border border-line bg-panel text-sm text-ink placeholder:text-faint ' +
  'transition-colors hover:border-line/80 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/50 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const inputClass = `${controlBaseClass} h-9 px-3`;
export const textareaClass = `${controlBaseClass} min-h-[6rem] px-3 py-2 resize-y`;
export const selectTriggerClass =
  'inline-flex h-9 w-full items-center justify-between gap-2 rounded-ctrl border border-line ' +
  'bg-panel px-3 text-sm text-ink transition-colors hover:border-line/80 ' +
  'focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/50 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-faint';

export const labelClass = 'block text-xs font-medium text-muted mb-1';
export const hintClass = 'mt-1 text-xs text-faint';
export const errorClass = 'mt-1 text-xs text-failed';

export function mergeClass(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
