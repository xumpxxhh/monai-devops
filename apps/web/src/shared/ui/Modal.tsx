import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useDialogOutsideGuard } from './useDialogOutsideGuard';

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  contentClassName?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  footer,
  contentClassName,
}: ModalProps) {
  const { shouldPreventDismiss } = useDialogOutsideGuard(open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30 backdrop-blur-sm z-50 overlay-in overlay-out" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full bg-surface rounded-card shadow-pop border border-line p-6 modal-content-in modal-content-out ${contentClassName ?? 'max-w-md'}`}
          onPointerDownOutside={(e) => {
            if (shouldPreventDismiss(e.target)) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (shouldPreventDismiss(e.target)) e.preventDefault();
          }}
          onFocusOutside={(e) => {
            if (shouldPreventDismiss(e.target)) e.preventDefault();
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-muted hover:text-ink p-1 rounded-ctrl">
              <FontAwesomeIcon icon={faXmark} />
            </Dialog.Close>
          </div>
          <div className="text-sm text-muted">{children}</div>
          {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
