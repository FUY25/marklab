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

  it('restores DOM globals when session setup rejects invalid Yjs state', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    await expect(runtime.serializeYjsState(new Uint8Array([1, 2, 3]))).rejects.toThrow();

    expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(previousWindow);

    const initialized = await runtime.initializeFromMarkdown('# Still usable\n');
    expect(initialized.markdown).toBe('# Still usable\n');
  });

  it('keeps concurrent headless sessions isolated while initializing, serializing, and applying changes', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const inputs = Array.from({ length: 8 }, (_, index) => ({
      original: `# Concurrent ${index}\n\nOriginal paragraph ${index}\n`,
      target: `# Concurrent ${index}\n\nChanged paragraph ${index}\n`,
    }));

    const outputs = await Promise.all(
      inputs.map(async (input) => {
        const initialized = await runtime.initializeFromMarkdown(input.original);
        const serialized = await runtime.serializeYjsState(initialized.yjsState);
        const applied = await runtime.applyChangedRanges({
          branchId: `br_${input.original.match(/\d+/u)?.[0] ?? 'x'}`,
          yjsState: serialized.yjsState,
          seedMarkdown: serialized.markdown,
          targetCanonicalMarkdown: input.target,
        });
        return applied.serializedMarkdown;
      }),
    );

    expect(outputs).toEqual(inputs.map((input) => input.target));
  });

  it('reports broad single-range replacements in changed range metadata', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const original = [
      '# Distant edits',
      '',
      'Alpha original paragraph.',
      '',
      'Middle paragraph remains the same.',
      '',
      'Omega original paragraph.',
      '',
    ].join('\n');
    const target = [
      '# Distant edits',
      '',
      'Alpha changed paragraph.',
      '',
      'Middle paragraph remains the same.',
      '',
      'Omega changed paragraph.',
      '',
    ].join('\n');
    const initialized = await runtime.initializeFromMarkdown(original);

    const applied = await runtime.applyChangedRanges({
      branchId: 'br_main',
      yjsState: initialized.yjsState,
      seedMarkdown: initialized.markdown,
      targetCanonicalMarkdown: target,
    });

    expect(applied.changedRangeCount).toBe(1);
    expect(applied.changedCharacterCount).toBeGreaterThan(target.length / 2);
    expect(applied.documentCharacterCount).toBe(target.length);
    expect(applied.fullDocumentReplacement).toBe(true);
  });

  it('reports broad deletions in changed range metadata', async () => {
    const runtime = createHeadlessMilkdownRuntime();
    const original = [
      '# Delete me',
      '',
      'This paragraph is going away.',
      '',
      'This one is also going away.',
      '',
      'And a final paragraph goes too.',
      '',
    ].join('\n');
    const initialized = await runtime.initializeFromMarkdown(original);

    const applied = await runtime.applyChangedRanges({
      branchId: 'br_main',
      yjsState: initialized.yjsState,
      seedMarkdown: initialized.markdown,
      targetCanonicalMarkdown: '',
    });

    expect(applied.changedRangeCount).toBe(1);
    expect(applied.changedCharacterCount).toBeGreaterThan(original.length / 2);
    expect(applied.documentCharacterCount).toBe(0);
    expect(applied.fullDocumentReplacement).toBe(true);
  });
});
