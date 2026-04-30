import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { encodeYjsStateFingerprint } from './yjs-state-fingerprint';

function stateVector(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return Buffer.from(Y.encodeStateVector(doc)).toString('base64');
  } finally {
    doc.destroy();
  }
}

describe('encodeYjsStateFingerprint', () => {
  it('changes for delete-only document updates that keep the same Yjs state vector', () => {
    const doc = new Y.Doc();
    try {
      const text = doc.getText('prosemirror');
      text.insert(0, 'delete me');
      const inserted = Y.encodeStateAsUpdate(doc);

      text.delete(0, 'delete me'.length);
      const deleted = Y.encodeStateAsUpdate(doc);

      expect(stateVector(inserted)).toBe(stateVector(deleted));
      expect(encodeYjsStateFingerprint(inserted)).not.toBe(encodeYjsStateFingerprint(deleted));
    } finally {
      doc.destroy();
    }
  });
});
