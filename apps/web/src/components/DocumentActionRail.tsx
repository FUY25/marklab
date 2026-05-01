import { History, Share2, type LucideIcon } from 'lucide-react';

type DocumentDrawerKind = 'versions' | 'share';

interface DocumentActionRailProps {
  activeDrawer: DocumentDrawerKind | null;
  onToggleDrawer: (drawer: DocumentDrawerKind) => void;
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

export function DocumentActionRail({ activeDrawer, onToggleDrawer, hidden = false, disabled = false }: DocumentActionRailProps) {
  if (hidden) return null;

  return (
    <nav
      className={activeDrawer ? 'document-action-rail document-action-rail-drawer-open' : 'document-action-rail'}
      data-testid="document-action-rail"
      aria-label="Document actions"
    >
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
