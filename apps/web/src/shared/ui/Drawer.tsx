import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useDialogOutsideGuard } from './useDialogOutsideGuard';

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}

export function Drawer({ open, onOpenChange, title, children }: DrawerProps) {
  const { shouldPreventDismiss } = useDialogOutsideGuard(open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/20 z-40" />
        <Dialog.Content
          className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-surface border-l border-line shadow-pop flex flex-col"
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
          <div className="flex items-center justify-between px-5 py-4 border-b border-line">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-muted hover:text-ink p-1 rounded-ctrl">
              <FontAwesomeIcon icon={faXmark} />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
