import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createAwarenessUser,
  createCursorAwareness,
  resolveCursorAwareness,
  type MarkLabAwarenessUser,
} from './awareness';

const user: MarkLabAwarenessUser = {
  id: 'session_1',
  name: 'Alice',
  color: '#2563eb',
  colorLight: '#dbeafe',
  kind: 'human',
};

describe('MarkLab awareness cursor state', () => {
  it('assigns stable, non-identical colors across participant sessions', () => {
    const alice = createAwarenessUser({ sessionId: 'session_alice', displayName: 'Alice', kind: 'human' });
    const aliceAgain = createAwarenessUser({ sessionId: 'session_alice', displayName: 'Alice 2', kind: 'human' });
    const bob = createAwarenessUser({ sessionId: 'session_bob', displayName: 'Bob', kind: 'human' });

    expect(alice.color).toBe(aliceAgain.color);
    expect(alice.colorLight).toBe(aliceAgain.colorLight);
    expect(alice.color).not.toBe(bob.color);
  });

  it('uses Yjs relative positions so cursor ranges survive preceding inserts', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Hello world');

    const cursor = createCursorAwareness(ytext, { anchor: 6, head: 11 }, user);
    ytext.insert(0, 'Remote ');

    expect(resolveCursorAwareness(ytext, cursor)).toEqual({
      anchor: 13,
      head: 18,
      user,
    });
  });
});
