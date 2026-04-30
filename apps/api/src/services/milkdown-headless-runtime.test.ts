import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createHeadlessMilkdownRuntime } from './milkdown-headless-runtime';

describe('createHeadlessMilkdownRuntime', () => {
  it('initializes valid non-empty Yjs state from Markdown and serializes canonical Markdown', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const result = await runtime.initializeFromMarkdown('# Imported\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');

    expect(result.yjsState.byteLength).toBeGreaterThan(0);
    expect(result.markdown).toContain('# Imported');
    expect(result.markdown).toContain('| A');
    expect(result.hash).toMatch(/^sha256:/u);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result.yjsState);
    expect(doc.getXmlFragment('prosemirror').length).toBeGreaterThan(0);
    doc.destroy();
  });

  it('serializes existing Yjs state through Milkdown before canonical formatting', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const initialized = await runtime.initializeFromMarkdown('## Live doc\n\nParagraph\n');
    const serialized = await runtime.serializeYjsState(initialized.yjsState);

    expect(serialized.markdown).toBe(initialized.markdown);
    expect(serialized.hash).toBe(initialized.hash);
    expect(serialized.yjsState.byteLength).toBeGreaterThan(0);
  });
});
