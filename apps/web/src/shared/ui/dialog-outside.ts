/** Portal 下拉（Cascader / Radix Select）与 Dialog 共存时的外部交互判断 */

const PICKER_PANEL_SELECTOR = [
  '[data-cascader-panel]',
  '[data-select-panel]',
  '[data-radix-select-content]',
  '[data-radix-popper-content-wrapper]',
].join(', ');

export function isPortaledPickerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(PICKER_PANEL_SELECTOR));
}

/** 下拉已打开时，点击外部应先关下拉，不应连带关掉 Dialog */
export function isPortaledPickerOpen(): boolean {
  return Boolean(document.querySelector(PICKER_PANEL_SELECTOR));
}
