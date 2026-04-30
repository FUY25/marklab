import { createHash } from 'node:crypto';
import * as Y from 'yjs';

export function encodeYjsStateFingerprint(yjsState: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    if (yjsState.byteLength > 0) Y.applyUpdate(doc, yjsState);
    const canonicalState = Y.encodeStateAsUpdate(doc);
    return `sha256:${createHash('sha256').update(canonicalState).digest('hex')}`;
  } finally {
    doc.destroy();
  }
}
