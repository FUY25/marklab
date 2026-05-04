import { normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';

export type ActiveNoteErrorCode = 'no_active_file' | 'not_markdown' | 'unsupported_vault_adapter';

export class ActiveNoteError extends Error {
  readonly code: ActiveNoteErrorCode;

  constructor(code: ActiveNoteErrorCode, message: string) {
    super(message);
    this.name = 'ActiveNoteError';
    this.code = code;
  }
}

interface FileSystemAdapterLike {
  getFullPath(path: string): string;
}

function hasFullPath(adapter: unknown): adapter is FileSystemAdapterLike {
  return typeof (adapter as FileSystemAdapterLike | null)?.getFullPath === 'function';
}

export function resolveActiveMarkdownFilePath(app: Pick<App, 'workspace' | 'vault'>): string {
  const activeFile = app.workspace.getActiveFile() as TFile | null;
  if (!activeFile) {
    throw new ActiveNoteError('no_active_file', 'Open a Markdown note before using MarkLab.');
  }

  if (activeFile.extension.toLowerCase() !== 'md') {
    throw new ActiveNoteError('not_markdown', 'MarkLab can only share Markdown notes.');
  }

  const adapter = app.vault.adapter;
  if (!hasFullPath(adapter)) {
    throw new ActiveNoteError('unsupported_vault_adapter', 'This vault adapter cannot provide a desktop file path.');
  }

  return adapter.getFullPath(normalizePath(activeFile.path));
}

export function humanizeActiveNoteError(error: unknown): string {
  if (error instanceof ActiveNoteError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
