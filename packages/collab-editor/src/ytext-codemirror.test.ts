// @vitest-environment jsdom

import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createIndexedDbPersistenceKey,
  createYTextCodeMirrorBinding,
} from './ytext-codemirror';

function createView(doc: string, extensions: Extension[] = []): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: document.body.appendChild(document.createElement('div')),
  });
}

describe('Y.Text CodeMirror binding', () => {
  it('uses provider doc id and session id in the IndexedDB persistence key', () => {
    expect(createIndexedDbPersistenceKey('ml_doc_1', 'session_1')).toBe('marklab:collab-web:ml_doc_1:session_1');
  });

  it('initializes CodeMirror from Y.Text and applies remote Y.Text changes', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, '# Shared\n');
    const view = createView('');

    const binding = createYTextCodeMirrorBinding({ view, ytext });
    ytext.insert(ytext.length, '\nRemote line');

    expect(view.state.doc.toString()).toBe('# Shared\n\nRemote line');
    binding.destroy();
    view.destroy();
  });

  it('writes local CodeMirror edits into Y.Text without echoing its own transaction', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const view = createView('Hello');

    const binding = createYTextCodeMirrorBinding({ view, ytext, preferInitial: 'editor' });
    view.dispatch({ changes: { from: 5, insert: ' world' } });

    expect(ytext.toString()).toBe('Hello world');
    expect(view.state.doc.toString()).toBe('Hello world');
    binding.destroy();
    view.destroy();
  });

  it('keeps remote Y.Text updates out of the local undo stack', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    const view = createView('Hello', [history()]);

    const binding = createYTextCodeMirrorBinding({ view, ytext, preferInitial: 'editor' });
    ytext.insert(ytext.length, ' from Alice');

    expect(view.state.doc.toString()).toBe('Hello from Alice');
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('Hello from Alice');
    expect(ytext.toString()).toBe('Hello from Alice');
    binding.destroy();
    view.destroy();
  });

  it('preserves the local cursor position when a remote Y.Text insert happens before it', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');
    const view = createView('');

    const binding = createYTextCodeMirrorBinding({ view, ytext });
    view.dispatch({ selection: EditorSelection.cursor('Hello'.length) });

    ytext.insert(0, 'Start ');
    view.dispatch({ changes: { from: view.state.selection.main.from, insert: '!' } });

    expect(view.state.doc.toString()).toBe('Start Hello! world');
    expect(ytext.toString()).toBe('Start Hello! world');
    binding.destroy();
    view.destroy();
  });
});
