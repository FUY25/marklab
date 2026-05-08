import type { MarkLabStatusEntry } from './cli-adapter';

export function sharingBlockReason(entry: MarkLabStatusEntry | undefined): string | null {
  if (!entry || entry.daemon !== 'running') return null;
  if (entry.hasConflict) return 'MarkLab reports a conflict for this note. Inspect the conflict before creating a share link.';

  switch (entry.syncState) {
    case 'paused':
    case 'sync_paused':
      return 'MarkLab sync is paused for this note. Resume or resolve sync before creating a share link.';
    case 'host_offline':
      return 'MarkLab reports the host as offline. Reopen MarkLab on the host before creating a share link.';
    case 'error':
      return 'MarkLab status is unavailable for this note. Check MarkLab before creating a share link.';
    default:
      return null;
  }
}
