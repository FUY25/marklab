import * as Y from 'yjs';

export interface MarkLabAwarenessUser {
  id: string;
  name: string;
  color: string;
  colorLight: string;
  kind: 'human' | 'agent';
}

export interface MarkLabAwarenessCursor {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

export interface MarkLabAwarenessState {
  user?: MarkLabAwarenessUser;
  cursor?: MarkLabAwarenessCursor | null;
}

export interface AbsoluteCursorSelection {
  anchor: number;
  head: number;
}

export interface ResolvedCursorAwareness extends AbsoluteCursorSelection {
  user: MarkLabAwarenessUser;
}

const fallbackColorPair = ['#2563eb', '#dbeafe'] as const;

const colorPairs: readonly (readonly [string, string])[] = [
  ['#2563eb', '#dbeafe'],
  ['#0891b2', '#cffafe'],
  ['#16a34a', '#dcfce7'],
  ['#ca8a04', '#fef3c7'],
  ['#dc2626', '#fee2e2'],
  ['#7c3aed', '#ede9fe'],
  ['#0f766e', '#ccfbf1'],
  ['#be185d', '#fce7f3'],
] as const;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createAwarenessUser(input: {
  sessionId: string;
  displayName: string;
  kind: MarkLabAwarenessUser['kind'];
}): MarkLabAwarenessUser {
  const [color, colorLight] = colorPairs[hashString(input.sessionId) % colorPairs.length] ?? fallbackColorPair;
  return {
    id: input.sessionId,
    name: input.displayName,
    color,
    colorLight,
    kind: input.kind,
  };
}

export function createCursorAwareness(
  ytext: Y.Text,
  selection: AbsoluteCursorSelection,
  user: MarkLabAwarenessUser,
): MarkLabAwarenessState {
  return {
    user,
    cursor: {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, selection.anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, selection.head),
    },
  };
}

function resolveRelativePosition(ytext: Y.Text, position: Y.RelativePosition): number | null {
  if (!ytext.doc) return null;
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, ytext.doc);
  if (!absolute || absolute.type !== ytext) return null;
  return absolute.index;
}

export function resolveCursorAwareness(ytext: Y.Text, state: MarkLabAwarenessState): ResolvedCursorAwareness | null {
  if (!state.user || !state.cursor) return null;
  const anchor = resolveRelativePosition(ytext, state.cursor.anchor);
  const head = resolveRelativePosition(ytext, state.cursor.head);
  if (anchor === null || head === null) return null;
  return { anchor, head, user: state.user };
}
