import { useRef } from 'react';
import { History, Plus, Share2, Upload, type LucideIcon } from 'lucide-react';

type DocumentDrawerKind = 'versions' | 'share';

interface DocumentActionRailProps {
  activeDrawer: DocumentDrawerKind | null;
  onToggleDrawer: (drawer: DocumentDrawerKind) => void;
  onCreateDocument?: (() => void) | undefined;
  onImportMarkdown?: ((file: File) => void) | undefined;
  hidden?: boolean;
  disabled?: boolean;
}

const actions: Array<{
  id: DocumentDrawerKind;
  label: string;
  Icon: LucideIcon;
}> = [
  { id: 'versions', label: 'Versions', Icon: History },
  { id: 'share', label: 'Share', Icon: Share2 },
];

export function DocumentActionRail({
  activeDrawer,
  onToggleDrawer,
  onCreateDocument,
  onImportMarkdown,
  hidden = false,
  disabled = false,
}: DocumentActionRailProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null);

  if (hidden) return null;

  return (
    <nav
      className={activeDrawer ? 'document-action-rail document-action-rail-drawer-open' : 'document-action-rail'}
      data-testid="document-action-rail"
      aria-label="Document actions"
    >
      {onCreateDocument ? (
        <button
          type="button"
          className="document-action-rail-button"
          data-testid="document-action-new"
          aria-label="New document"
          title="New document"
          disabled={disabled}
          onClick={onCreateDocument}
        >
          <Plus className="document-action-rail-icon" aria-hidden="true" />
        </button>
      ) : null}
      {onImportMarkdown ? (
        <>
          <button
            type="button"
            className="document-action-rail-button"
            data-testid="document-action-import"
            aria-label="Import Markdown"
            title="Import Markdown"
            disabled={disabled}
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="document-action-rail-icon" aria-hidden="true" />
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            aria-label="Import Markdown file"
            className="home-hidden-file-input"
            disabled={disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onImportMarkdown(file);
              event.currentTarget.value = '';
            }}
          />
        </>
      ) : null}
      {actions.map((action) => {
        const isActive = activeDrawer === action.id;
        const { Icon } = action;
        return (
          <button
            key={action.id}
            type="button"
            className={isActive ? 'document-action-rail-button document-action-rail-button-active' : 'document-action-rail-button'}
            data-testid={`document-action-${action.id}`}
            aria-label={action.label}
            aria-pressed={isActive}
            title={action.label}
            disabled={disabled}
            onClick={() => onToggleDrawer(action.id)}
          >
            <Icon className="document-action-rail-icon" aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}

export type { DocumentDrawerKind, DocumentActionRailProps };
