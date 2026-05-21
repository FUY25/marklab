// @vitest-environment jsdom

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createCursorAwareness, type MarkLabAwarenessUser } from './awareness';
import {
  buildRemoteCursorDecorations,
  createRemoteCursorExtension,
  remoteCursorLabelVisibleMs,
  resolveRemoteCursorSelections,
  safeAwarenessColor,
  summarizeRemoteCursors,
} from './remote-cursors';

const remoteUser: MarkLabAwarenessUser = {
  id: 'session_remote',
  name: 'Remote',
  color: '#dc2626',
  colorLight: '#fee2e2',
  kind: 'human',
  clientKind: 'browser',
};

let mountedViews: EditorView[] = [];

afterEach(() => {
  for (const view of mountedViews) view.destroy();
  mountedViews = [];
  document.body.replaceChildren();
});

function createView(doc: string, extensions: Extension[] = []): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: document.body.appendChild(document.createElement('div')),
  });
  mountedViews.push(view);
  return view;
}

describe('remote cursor rendering', () => {
  it('sanitizes client-supplied awareness colors before using them as CSS', () => {
    expect(safeAwarenessColor('#2563eb', '#000000')).toBe('#2563eb');
    expect(safeAwarenessColor('rgba(1, 2, 3, 0.5)', '#000000')).toBe('rgba(1, 2, 3, 0.5)');
    expect(safeAwarenessColor('url(javascript:alert(1))', '#000000')).toBe('#000000');
  });

  it('summarizes remote participants for preview-only presence indicators', () => {
    const states = new Map([
      [1, { user: { ...remoteUser, name: 'Local' } }],
      [2, { user: remoteUser }],
    ]);

    expect(summarizeRemoteCursors(states, 1)).toEqual([{
      clientId: 2,
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
    }]);
  });

  it('normalizes malformed remote user names before rendering summaries', () => {
    const longName = 'Remote'.repeat(100);
    const states = new Map<number, unknown>([
      [1, { user: { ...remoteUser, name: 'Local' } }],
      [2, { user: { id: 7, name: { bad: true }, color: 'url(javascript:bad)', colorLight: null, kind: 'robot' } }],
      [3, { user: { ...remoteUser, name: longName } }],
      [4, { user: 'not-a-user' }],
      [5, null],
      [6, 'bad-state'],
      [7, 7],
    ]);

    const summaries = summarizeRemoteCursors(states as unknown as ReadonlyMap<number, never>, 1);

    expect(summaries).toEqual([{
      clientId: 2,
      name: 'Guest',
      color: '#2563eb',
      colorLight: '#dbeafe',
      kind: 'human',
    }, {
      clientId: 3,
      name: longName.slice(0, 80),
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
    }]);
  });

  it('resolves remote cursor ranges from Yjs relative positions after preceding inserts', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');
    const remoteState = createCursorAwareness(ytext, { anchor: 6, head: 11 }, remoteUser);
    ytext.insert(0, 'Shared ');

    expect(resolveRemoteCursorSelections(ytext, new Map([[42, remoteState]]), doc.clientID)).toEqual([{
      clientId: 42,
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
      anchor: 13,
      head: 18,
    }]);
  });

  it('builds caret and selection decorations for remote source-pane cursors', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'one\ntwo\nthree');
    const view = createView(ytext.toString());
    const decorations = buildRemoteCursorDecorations(
      view,
      ytext,
      new Map([[42, createCursorAwareness(ytext, { anchor: 1, head: 9 }, remoteUser)]]),
      doc.clientID,
    );

    expect(decorations.size).toBeGreaterThanOrEqual(3);
  });

  it('updates CodeMirror when remote awareness changes', () => {
    const localDoc = new Y.Doc();
    const ytext = localDoc.getText('contents');
    ytext.insert(0, 'Hello world');
    const localAwareness = new Awareness(localDoc);
    const view = createView(ytext.toString(), [
      createRemoteCursorExtension({ awareness: localAwareness, ytext, localClientId: localDoc.clientID }),
    ]);
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);

    remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 6, head: 11 }, remoteUser));
    applyAwarenessUpdate(
      localAwareness,
      encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
      'test',
    );

    expect(view.dom.querySelector('.cm-marklab-remote-caret')).not.toBeNull();
    expect(view.dom.querySelector('.cm-marklab-remote-selection')).not.toBeNull();
  });

  it('keeps the remote caret live but only shows the name label briefly after movement', () => {
    vi.useFakeTimers();
    const localDoc = new Y.Doc();
    const ytext = localDoc.getText('contents');
    ytext.insert(0, 'Hello world');
    const localAwareness = new Awareness(localDoc);
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    try {
      const view = createView(ytext.toString(), [
        createRemoteCursorExtension({ awareness: localAwareness, ytext, localClientId: localDoc.clientID }),
      ]);

      remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 5, head: 5 }, remoteUser));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      expect(view.dom.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      expect(view.dom.querySelector('.cm-marklab-remote-caret-label-visible')).not.toBeNull();

      remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 11, head: 11 }, remoteUser));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      expect(view.dom.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      expect(view.dom.querySelector('.cm-marklab-remote-caret-label-visible')).not.toBeNull();

      vi.advanceTimersByTime(remoteCursorLabelVisibleMs + 1);

      expect(view.dom.querySelector('.cm-marklab-remote-caret')).not.toBeNull();
      expect(view.dom.querySelector('.cm-marklab-remote-caret-label-visible')).toBeNull();
    } finally {
      localAwareness.destroy();
      remoteAwareness.destroy();
      localDoc.destroy();
      remoteDoc.destroy();
      vi.useRealTimers();
    }
  });

  it('removes the remote caret immediately when a peer clears awareness before disconnecting', () => {
    const localDoc = new Y.Doc();
    const ytext = localDoc.getText('contents');
    ytext.insert(0, 'Hello world');
    const localAwareness = new Awareness(localDoc);
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    try {
      const view = createView(ytext.toString(), [
        createRemoteCursorExtension({ awareness: localAwareness, ytext, localClientId: localDoc.clientID }),
      ]);

      remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 5, head: 5 }, remoteUser));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );
      expect(view.dom.querySelector('.cm-marklab-remote-caret')).not.toBeNull();

      remoteAwareness.setLocalState(null);
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      expect(view.dom.querySelector('.cm-marklab-remote-caret')).toBeNull();
    } finally {
      localAwareness.destroy();
      remoteAwareness.destroy();
      localDoc.destroy();
      remoteDoc.destroy();
    }
  });

  it('ignores malformed remote cursor payloads without breaking decorations', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');
    const view = createView(ytext.toString());

    const decorations = buildRemoteCursorDecorations(
      view,
      ytext,
      new Map([[42, {
        user: remoteUser,
        cursor: { anchor: null, head: 'bad' },
      } as unknown as never]]),
      doc.clientID,
    );

    expect(decorations.size).toBe(0);
  });
});
