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
const maxAwarenessIdentityLength = 80;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeAwarenessUser(value: unknown): MarkLabAwarenessUser | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' && value.id ? value.id.slice(0, maxAwarenessIdentityLength) : 'remote';
  const name = typeof value.name === 'string' && value.name ? value.name.slice(0, maxAwarenessIdentityLength) : 'Guest';
  const color = typeof value.color === 'string' ? value.color : fallbackColorPair[0];
  const colorLight = typeof value.colorLight === 'string' ? value.colorLight : fallbackColorPair[1];
  const kind = value.kind === 'agent' ? 'agent' : 'human';
  return { id, name, color, colorLight, kind };
}

function topLevelYTextName(ytext: Y.Text): string | null {
  const share = (ytext.doc as unknown as { share?: Map<string, unknown> } | null)?.share;
  if (!share) return null;
  for (const [name, type] of share.entries()) {
    if (type === ytext) return name;
  }
  return null;
}

function isYjsIdLike(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value.client)
    && Number(value.client) >= 0
    && Number.isSafeInteger(value.clock)
    && Number(value.clock) >= 0;
}

function isRelativePositionForYText(ytext: Y.Text, position: unknown): position is Y.RelativePosition {
  if (!isRecord(position)) return false;
  const ytextName = topLevelYTextName(ytext);
  if (!ytextName || position.tname !== ytextName) return false;
  if (position.type !== null) return false;
  if (position.item !== null && !isYjsIdLike(position.item)) return false;
  if (position.assoc !== undefined && typeof position.assoc !== 'number') return false;
  return true;
}

function resolveRelativePosition(ytext: Y.Text, position: unknown): number | null {
  if (!ytext.doc) return null;
  if (!isRelativePositionForYText(ytext, position)) return null;
  let absolute: ReturnType<typeof Y.createAbsolutePositionFromRelativePosition>;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(position, ytext.doc);
  } catch {
    return null;
  }
  if (!absolute || absolute.type !== ytext) return null;
  return absolute.index;
}

export function resolveCursorAwareness(ytext: Y.Text, state: unknown): ResolvedCursorAwareness | null {
  if (!isRecord(state)) return null;
  const user = normalizeAwarenessUser(state.user);
  if (!user || !isRecord(state.cursor)) return null;
  const anchor = resolveRelativePosition(ytext, state.cursor.anchor);
  const head = resolveRelativePosition(ytext, state.cursor.head);
  if (anchor === null || head === null) return null;
  return { anchor, head, user };
}
