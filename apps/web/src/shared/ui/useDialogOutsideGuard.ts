import { useEffect, useRef } from 'react';
import { isPortaledPickerOpen, isPortaledPickerTarget } from './dialog-outside';

/**
 * Dialog 嵌套 Portal 下拉时：在 pointerdown 捕获阶段记下「当时下拉是否打开」，
 * 避免下拉先卸载后 Dialog 误判为外部点击而关闭。
 */
export function useDialogOutsideGuard(dialogOpen: boolean) {
  const pickerWasOpenRef = useRef(false);

  useEffect(() => {
    if (!dialogOpen) return;
    const onPointerDownCapture = () => {
      pickerWasOpenRef.current = isPortaledPickerOpen();
    };
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => document.removeEventListener('pointerdown', onPointerDownCapture, true);
  }, [dialogOpen]);

  const shouldPreventDismiss = (target: EventTarget | null) =>
    pickerWasOpenRef.current || isPortaledPickerTarget(target) || isPortaledPickerOpen();

  return { shouldPreventDismiss };
}
