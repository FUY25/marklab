// @vitest-environment jsdom

import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createCursorAwareness, type MarkLabAwarenessState, type MarkLabAwarenessUser } from './awareness';
import {
  awarenessClientMeta,
  buildRemoteCursorDecorations,
  createRemoteCursorExtension,
  remoteCursorLabelVisibleMs,
  resolveRemoteCursorSelections,
  safeAwarenessColor,
  summarizeRemoteCursors,
  type AwarenessClientMeta,
} from './remote-cursors';

const remoteUser: MarkLabAwarenessUser = {
  id: 'session_remote',
  name: 'Remote',
  color: '#dc2626',
  colorLight: '#fee2e2',
  kind: 'human',
  clientKind: 'browser',
};

function remoteUserWithoutClientKind(): MarkLabAwarenessUser {
  const { clientKind: _clientKind, ...user } = remoteUser;
  return user;
}

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
      userId: 'session_remote',
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
    }]);
  });

  it('keeps same-name collaborator summaries separate when their awareness identities differ', () => {
    const states = new Map([
      [1, { user: { ...remoteUser, name: 'Local' } }],
      [2, { user: { ...remoteUser, id: 'session_guest_1', name: 'Guest', color: '#dc2626', colorLight: '#fee2e2' } }],
      [3, { user: { ...remoteUser, id: 'session_guest_2', name: 'Guest', color: '#0891b2', colorLight: '#cffafe' } }],
    ]);
    const meta = new Map<number, AwarenessClientMeta>([
      [2, { clock: 8, lastUpdated: 1000 }],
      [3, { clock: 1, lastUpdated: 2000 }],
    ]);

    expect(summarizeRemoteCursors(states, 1, { meta })).toEqual([
      {
        clientId: 2,
        userId: 'session_guest_1',
        name: 'Guest',
        color: '#dc2626',
        colorLight: '#fee2e2',
        kind: 'human',
        clientKind: 'browser',
      },
      {
        clientId: 3,
        userId: 'session_guest_2',
        name: 'Guest',
        color: '#0891b2',
        colorLight: '#cffafe',
        kind: 'human',
        clientKind: 'browser',
      },
    ]);
  });

  it('collapses duplicate collaborator summaries only when their awareness identity matches', () => {
    const currentUser: MarkLabAwarenessUser = { ...remoteUser, clientKind: 'browser', color: '#0891b2', colorLight: '#cffafe' };
    const states = new Map<number, MarkLabAwarenessState>([
      [2, { user: remoteUserWithoutClientKind() }],
      [3, { user: currentUser }],
    ]);
    const meta = new Map<number, AwarenessClientMeta>([
      [2, { clock: 8, lastUpdated: 1000 }],
      [3, { clock: 1, lastUpdated: 2000 }],
    ]);

    expect(summarizeRemoteCursors(states, 1, { meta })).toEqual([{
      clientId: 3,
      userId: 'session_remote',
      name: 'Remote',
      color: '#0891b2',
      colorLight: '#cffafe',
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
      userId: 'remote',
      name: 'Guest',
      color: '#2563eb',
      colorLight: '#dbeafe',
      kind: 'human',
    }, {
      clientId: 3,
      userId: 'session_remote',
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
      userId: 'session_remote',
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
      anchor: 13,
      head: 18,
    }]);
  });

  it('keeps a same-name cursor visible when a fresher duplicate session has no cursor', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');
    const meta = new Map<number, AwarenessClientMeta>([
      [2, { clock: 8, lastUpdated: 1000 }],
      [3, { clock: 1, lastUpdated: 2000 }],
    ]);

    expect(resolveRemoteCursorSelections(
      ytext,
      new Map([
        [2, createCursorAwareness(ytext, { anchor: 5, head: 5 }, remoteUser)],
        [3, { user: remoteUser }],
      ]),
      1,
      { meta },
    )).toEqual([{
      clientId: 2,
      userId: 'session_remote',
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
      anchor: 5,
      head: 5,
    }]);
  });

  it('keeps same-name remote cursors separate when their awareness identities differ', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');

    expect(resolveRemoteCursorSelections(
      ytext,
      new Map([
        [2, createCursorAwareness(ytext, { anchor: 2, head: 2 }, { ...remoteUser, id: 'guest_one', name: 'Guest' })],
        [3, createCursorAwareness(ytext, { anchor: 9, head: 9 }, { ...remoteUser, id: 'guest_two', name: 'Guest' })],
      ]),
      1,
    )).toEqual([
      {
        clientId: 2,
        userId: 'guest_one',
        name: 'Guest',
        color: '#dc2626',
        colorLight: '#fee2e2',
        kind: 'human',
        clientKind: 'browser',
        anchor: 2,
        head: 2,
      },
      {
        clientId: 3,
        userId: 'guest_two',
        name: 'Guest',
        color: '#dc2626',
        colorLight: '#fee2e2',
        kind: 'human',
        clientKind: 'browser',
        anchor: 9,
        head: 9,
      },
    ]);
  });

  it('keeps the freshest cursor when duplicate same-name sessions use different client kinds', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');
    const oldUser = remoteUserWithoutClientKind();
    const currentUser: MarkLabAwarenessUser = { ...remoteUser, clientKind: 'browser' };
    const meta = new Map<number, AwarenessClientMeta>([
      [2, { clock: 8, lastUpdated: 1000 }],
      [3, { clock: 1, lastUpdated: 2000 }],
    ]);

    expect(resolveRemoteCursorSelections(
      ytext,
      new Map([
        [2, createCursorAwareness(ytext, { anchor: 2, head: 2 }, oldUser)],
        [3, createCursorAwareness(ytext, { anchor: 9, head: 9 }, currentUser)],
      ]),
      1,
      { meta },
    )).toEqual([{
      clientId: 3,
      userId: 'session_remote',
      name: 'Remote',
      color: '#dc2626',
      colorLight: '#fee2e2',
      kind: 'human',
      clientKind: 'browser',
      anchor: 9,
      head: 9,
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

  it('moves the remote caret without recreating the widget DOM', () => {
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
      const firstCaret = view.dom.querySelector('.cm-marklab-remote-caret');
      expect(firstCaret).not.toBeNull();

      remoteAwareness.setLocalState(createCursorAwareness(ytext, { anchor: 11, head: 11 }, remoteUser));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      const secondCaret = view.dom.querySelector('.cm-marklab-remote-caret');
      expect(secondCaret).not.toBeNull();
      expect(view.dom.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      expect(secondCaret).toBe(firstCaret);
    } finally {
      localAwareness.destroy();
      remoteAwareness.destroy();
      localDoc.destroy();
      remoteDoc.destroy();
    }
  });

  it('does not render a source-pane caret or pill for collaborators with no cursor', () => {
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

      remoteAwareness.setLocalState({ user: remoteUser });
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
        'test',
      );

      expect(view.dom.querySelector('.cm-marklab-remote-caret')).toBeNull();
      expect(view.dom.querySelector('.cm-marklab-remote-caret-label')).toBeNull();
    } finally {
      localAwareness.destroy();
      remoteAwareness.destroy();
      localDoc.destroy();
      remoteDoc.destroy();
    }
  });

  it('renders one moving caret for duplicate same-name sessions across client kinds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
    const localDoc = new Y.Doc();
    const ytext = localDoc.getText('contents');
    ytext.insert(0, 'Hello world');
    const localAwareness = new Awareness(localDoc);
    const oldDoc = new Y.Doc();
    const oldAwareness = new Awareness(oldDoc);
    const currentDoc = new Y.Doc();
    const currentAwareness = new Awareness(currentDoc);
    try {
      const view = createView(ytext.toString(), [
        createRemoteCursorExtension({ awareness: localAwareness, ytext, localClientId: localDoc.clientID }),
      ]);

      oldAwareness.setLocalState(createCursorAwareness(
        ytext,
        { anchor: 2, head: 2 },
        remoteUserWithoutClientKind(),
      ));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(oldAwareness, [oldDoc.clientID]),
        'test',
      );
      vi.setSystemTime(new Date('2026-05-27T12:00:01.000Z'));
      currentAwareness.setLocalState(createCursorAwareness(
        ytext,
        { anchor: 8, head: 8 },
        { ...remoteUser, clientKind: 'browser' },
      ));
      currentAwareness.setLocalState(createCursorAwareness(
        ytext,
        { anchor: 9, head: 9 },
        { ...remoteUser, clientKind: 'browser' },
      ));
      applyAwarenessUpdate(
        localAwareness,
        encodeAwarenessUpdate(currentAwareness, [currentDoc.clientID]),
        'test',
      );

      expect(view.dom.querySelectorAll('.cm-marklab-remote-caret')).toHaveLength(1);
      expect(view.dom.querySelectorAll('.cm-marklab-remote-caret-label-visible')).toHaveLength(1);
      expect(resolveRemoteCursorSelections(
        ytext,
        localAwareness.getStates() as unknown as ReadonlyMap<number, MarkLabAwarenessState>,
        localDoc.clientID,
        { meta: awarenessClientMeta(localAwareness) },
      )[0]?.head).toBe(9);
    } finally {
      localAwareness.destroy();
      oldAwareness.destroy();
      currentAwareness.destroy();
      localDoc.destroy();
      oldDoc.destroy();
      currentDoc.destroy();
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
