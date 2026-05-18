// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { runMarkdownEditorCommand } from './markdown-commands';

function createView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc }),
    parent: document.body.appendChild(document.createElement('div')),
  });
}

describe('Markdown editor commands', () => {
  it('toggles heading markers without dropping indentation', () => {
    const view = createView('  ## Nested\n');
    runMarkdownEditorCommand(view, { type: 'heading', level: 2 });

    expect(view.state.doc.toString()).toBe('  Nested\n');
    view.destroy();
  });

  it('toggles inline marks around an empty caret inside existing text', () => {
    const view = createView('**bold**');
    view.dispatch({ selection: EditorSelection.cursor(3) });

    runMarkdownEditorCommand(view, { type: 'bold' });

    expect(view.state.doc.toString()).toBe('bold');
    expect(view.state.selection.main.head).toBe(1);
    view.destroy();
  });

  it('preserves nested indentation when removing list markers', () => {
    const view = createView('  - Nested\n');
    runMarkdownEditorCommand(view, { type: 'unorderedList' });

    expect(view.state.doc.toString()).toBe('  Nested\n');
    view.destroy();
  });

  it('does not include the next line when a selection ends at line start', () => {
    const view = createView('- One\nPlain\n');
    view.dispatch({ selection: EditorSelection.range(0, '- One\n'.length) });

    runMarkdownEditorCommand(view, { type: 'unorderedList' });

    expect(view.state.doc.toString()).toBe('One\nPlain\n');
    view.destroy();
  });
});
