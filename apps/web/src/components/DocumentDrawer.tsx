import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface DocumentDrawerProps {
  id?: string;
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
  labelledById?: string;
  testId?: string;
}

export function DocumentDrawer({
  id,
  title,
  open,
  onClose,
  children,
  footer,
  className,
  bodyClassName,
  closeLabel = 'Close drawer',
  labelledById,
  testId = 'document-drawer',
}: DocumentDrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const titleId = labelledById ?? (id ? `${id}-title` : undefined);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    drawerRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="document-drawer-layer" data-testid="document-drawer-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside
        ref={drawerRef}
        id={id}
        className={className ? `document-drawer ${className}` : 'document-drawer'}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="document-drawer-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="document-drawer-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <X className="document-drawer-close-icon" aria-hidden="true" />
          </button>
        </header>
        <div className={bodyClassName ? `document-drawer-body ${bodyClassName}` : 'document-drawer-body'}>{children}</div>
        {footer ? <footer className="document-drawer-footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}

export type { DocumentDrawerProps };
