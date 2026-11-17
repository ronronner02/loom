import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus returns here when the sheet closes; these sheets have no Radix trigger to own it. */
  opener: RefObject<HTMLElement | null>;
  title: ReactNode;
  closeLabel: string;
  description?: ReactNode;
  /** Header controls between the title and the close button. */
  headerActions?: ReactNode;
  /** While locked, Escape and an outside click do not close a sheet with work in flight. */
  locked?: boolean;
  contentClassName: string;
  bodyClassName?: string;
  overlayClassName?: string;
  headerClassName?: string;
  titleClassName?: string;
  children: ReactNode;
}

/**
 * The one dialog chrome the product's sheets share: overlay, focus-trapped content, a header with
 * the title and close button, and focus restored to the opener on close.
 */
export function Sheet({ open, onOpenChange, opener, title, closeLabel, description, headerActions, locked = false,
  contentClassName, bodyClassName, overlayClassName = "ui-dialog-overlay",
  headerClassName = "ui-panel-heading", titleClassName, children }: SheetProps) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Overlay className={overlayClassName} />
    {/* Radix warns when a dialog has neither a description nor an explicit decline of one;
        the sheet's description is optional, so the warning is always declined. */}
    <Dialog.Content className={contentClassName} aria-describedby={undefined}
      onCloseAutoFocus={event => {
        event.preventDefault(); opener.current?.focus();
      }}
      onEscapeKeyDown={event => { if (locked) event.preventDefault(); }}
      onInteractOutside={event => { if (locked) event.preventDefault(); }}>
      <header className={headerClassName}>
        <div>
          <Dialog.Title className={titleClassName}>{title}</Dialog.Title>
          {description && <Dialog.Description>{description}</Dialog.Description>}
        </div>
        {headerActions}
        <Dialog.Close className="ui-icon-button" aria-label={closeLabel} disabled={locked}><X aria-hidden="true" /></Dialog.Close>
      </header>
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </Dialog.Content>
  </Dialog.Root>;
}