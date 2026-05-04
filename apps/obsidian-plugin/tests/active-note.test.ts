import { describe, expect, it } from 'vitest';
import { ActiveNoteError, resolveActiveMarkdownFilePath } from '../src/active-note';

function appWithActiveFile(file: { path: string; extension: string } | null) {
  return {
    workspace: {
      getActiveFile: () => file,
    },
    vault: {
      adapter: {
        getFullPath: (path: string) => `/vault/${path}`,
      },
    },
  } as never;
}

describe('resolveActiveMarkdownFilePath', () => {
  it('resolves the active Markdown note through the vault adapter', () => {
    expect(resolveActiveMarkdownFilePath(appWithActiveFile({ path: 'Folder/My Note.md', extension: 'md' }))).toBe('/vault/Folder/My Note.md');
  });

  it('rejects missing active files', () => {
    expect(() => resolveActiveMarkdownFilePath(appWithActiveFile(null))).toThrow(ActiveNoteError);
  });

  it('rejects non-Markdown files', () => {
    expect(() => resolveActiveMarkdownFilePath(appWithActiveFile({ path: 'image.png', extension: 'png' }))).toThrow('Markdown notes');
  });

  it('rejects adapters without desktop file path support', () => {
    const app = {
      workspace: {
        getActiveFile: () => ({ path: 'Note.md', extension: 'md' }),
      },
      vault: {
        adapter: {},
      },
    } as never;

    expect(() => resolveActiveMarkdownFilePath(app)).toThrow('desktop file path');
  });
});
