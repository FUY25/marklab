import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createAwarenessUser,
  createCursorAwareness,
  resolveCursorAwareness,
} from './awareness';

describe('shared awareness helpers', () => {
  it('publishes cursor state as Yjs relative positions that survive concurrent edits', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'alpha beta gamma');
    const user = createAwarenessUser({ sessionId: 'session_app_1', displayName: 'MarkLab.app', kind: 'human', clientKind: 'app' });
    const state = createCursorAwareness(ytext, { anchor: 6, head: 10 }, user);

    ytext.insert(0, 'intro ');
    const resolved = resolveCursorAwareness(ytext, state);

    expect(resolved).toMatchObject({
      anchor: 12,
      head: 16,
      user: {
        id: 'session_app_1',
        name: 'MarkLab.app',
        kind: 'human',
        clientKind: 'app',
      },
    });
  });
});
