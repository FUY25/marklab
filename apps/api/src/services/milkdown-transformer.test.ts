import { describe, expect, it } from 'vitest';
import { flushBranchMarkdownMirror, initializeBranchEditorState } from './milkdown-transformer';

describe('milkdown transformer seam', () => {
  it('fails closed until the real Milkdown serializer is configured', async () => {
    await expect(initializeBranchEditorState('# Imported\n')).rejects.toThrow('milkdown_transformer_not_configured');
  });

  it('fails closed before export reads the mirror when flushing is unavailable', async () => {
    await expect(flushBranchMarkdownMirror({ query: async () => ({ rows: [] }) }, 'doc_001', 'br_main')).rejects.toThrow(
      'milkdown_transformer_not_configured',
    );
  });
});
