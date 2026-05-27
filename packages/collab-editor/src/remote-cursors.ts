// Code in this file has been adapted from y-codemirror.next.
// License: MIT License, Copyright (c) 2024 Kevin Jahns.

import { Annotation, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import {
  normalizeAwarenessUser,
  resolveCursorAwareness,
  type MarkLabAwarenessState,
  type MarkLabAwarenessUser,
} from './awareness';

export interface RemoteCursorSummary {
  clientId: number;
  name: string;
  color: string;
  colorLight: string;
  kind: MarkLabAwarenessUser['kind'];
  clientKind?: MarkLabAwarenessUser['clientKind'];
}

export interface ResolvedRemoteCursorSelection extends RemoteCursorSummary {
  anchor: number;
  head: number;
}

export const remoteCursorLabelVisibleMs = 1400;

export interface AwarenessClientMeta {
  clock: number;
  lastUpdated: number;
}

interface RemoteCursorOptions {
  meta?: ReadonlyMap<number, AwarenessClientMeta> | undefined;
}

type RemoteCursorLabelMode = 'transient' | 'always';
type RemoteCursorLabelRenderer = 'inline' | 'overlay';

function awarenessRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function awarenessClientMeta(input: Awareness): ReadonlyMap<number, AwarenessClientMeta> | undefined {
  const meta = (input as unknown as { meta?: ReadonlyMap<number, AwarenessClientMeta> }).meta;
  return meta instanceof Map ? meta : undefined;
}

function participantIdentityKey(participant: Pick<RemoteCursorSummary, 'name' | 'kind'>): string {
  const normalizedName = participant.name.trim().toLocaleLowerCase();
  return [
    participant.kind,
    normalizedName || 'guest',
  ].join('|');
}

function participantFreshnessScore(
  clientId: number,
  meta: ReadonlyMap<number, AwarenessClientMeta> | undefined,
): readonly [number, number, number] {
  const clientMeta = meta?.get(clientId);
  return [clientMeta?.lastUpdated ?? 0, clientMeta?.clock ?? 0, clientId] as const;
}

function isFresherParticipant(
  candidate: RemoteCursorSummary,
  existing: RemoteCursorSummary,
  meta: ReadonlyMap<number, AwarenessClientMeta> | undefined,
): boolean {
  const nextScore = participantFreshnessScore(candidate.clientId, meta);
  const currentScore = participantFreshnessScore(existing.clientId, meta);
  return nextScore[0] > currentScore[0]
    || (nextScore[0] === currentScore[0] && nextScore[1] > currentScore[1])
    || (nextScore[0] === currentScore[0] && nextScore[1] === currentScore[1] && nextScore[2] > currentScore[2]);
}

function dedupeRemoteParticipants<T extends RemoteCursorSummary>(
  candidates: T[],
  meta: ReadonlyMap<number, AwarenessClientMeta> | undefined,
): T[] {
  const byIdentity = new Map<string, T>();
  for (const candidate of candidates) {
    const key = participantIdentityKey(candidate);
    const existing = byIdentity.get(key);
    if (!existing || isFresherParticipant(candidate, existing, meta)) {
      byIdentity.set(key, candidate);
    }
  }
  return [...byIdentity.values()].sort((left, right) => left.clientId - right.clientId);
}

export function safeAwarenessColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/iu.test(value)) return value;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/iu.test(value)) return value;
  return fallback;
}

export function summarizeRemoteCursors(
  states: ReadonlyMap<number, MarkLabAwarenessState>,
  localClientId: number,
  options: RemoteCursorOptions = {},
): RemoteCursorSummary[] {
  const candidates = [...states.entries()]
    .flatMap(([clientId, state]) => {
      if (clientId === localClientId) return [];
      const record = awarenessRecord(state);
      if (!record) return [];
      const user = normalizeAwarenessUser(record.user);
      if (!user) return [];
      return [{
        clientId,
        name: user.name,
        color: safeAwarenessColor(user.color, '#2563eb'),
        colorLight: safeAwarenessColor(user.colorLight, '#dbeafe'),
        kind: user.kind,
        ...(user.clientKind ? { clientKind: user.clientKind } : {}),
      }];
    });
  return dedupeRemoteParticipants(candidates, options.meta);
}

export function resolveRemoteCursorSelections(
  ytext: Y.Text,
  states: ReadonlyMap<number, MarkLabAwarenessState>,
  localClientId: number,
  options: RemoteCursorOptions = {},
): ResolvedRemoteCursorSelection[] {
  const candidates = [...states.entries()].flatMap<ResolvedRemoteCursorSelection>(([clientId, state]) => {
    if (clientId === localClientId) return [];
    const record = awarenessRecord(state);
    if (!record) return [];
    const user = normalizeAwarenessUser(record.user);
    if (!user) return [];
    const cursor = resolveCursorAwareness(ytext, state);
    if (!cursor) return [];
    return [{
      clientId,
      name: user.name,
      color: safeAwarenessColor(user.color, '#2563eb'),
      colorLight: safeAwarenessColor(user.colorLight, '#dbeafe'),
      kind: user.kind,
      ...(user.clientKind ? { clientKind: user.clientKind } : {}),
      anchor: cursor.anchor,
      head: cursor.head,
    }];
  });
  return dedupeRemoteParticipants(candidates, options.meta);
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
    private readonly showLabel: boolean,
    private readonly positionSignature: string,
    private readonly renderInlineLabel: boolean,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const caret = view.dom.ownerDocument.createElement('span');
    caret.className = `cm-marklab-remote-caret${this.showLabel ? ' cm-marklab-remote-caret-label-visible' : ''}`;
    caret.style.borderColor = this.color;
    caret.style.backgroundColor = this.color;

    const dot = view.dom.ownerDocument.createElement('span');
    dot.className = 'cm-marklab-remote-caret-dot';
    caret.append(dot);

    if (this.renderInlineLabel) {
      const label = view.dom.ownerDocument.createElement('span');
      label.className = 'cm-marklab-remote-caret-label';
      label.textContent = this.name;
      caret.append(label);
    }

    return caret;
  }

  eq(other: RemoteCaretWidget): boolean {
    return this.color === other.color
      && this.name === other.name
      && this.showLabel === other.showLabel
      && this.positionSignature === other.positionSignature
      && this.renderInlineLabel === other.renderInlineLabel;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const markLabRemoteCursorTheme = EditorView.baseTheme({
  '.cm-marklab-remote-selection': {},
  '.cm-marklab-remote-line-selection': {
    padding: '0',
    margin: '0',
  },
  '.cm-marklab-remote-caret': {
    position: 'relative',
    display: 'inline-block',
    width: '0',
    height: '1.35em',
    verticalAlign: 'text-bottom',
    borderLeft: '2px solid',
    borderRight: '0',
    marginLeft: '-1px',
    marginRight: '1px',
    boxSizing: 'border-box',
    color: '#ffffff',
    pointerEvents: 'none',
    zIndex: '20',
  },
  '.cm-marklab-remote-caret-dot': {
    position: 'absolute',
    top: '-2px',
    left: '-4px',
    width: '7px',
    height: '7px',
    borderRadius: '999px',
    backgroundColor: 'inherit',
  },
  '.cm-marklab-remote-caret-label': {
    position: 'absolute',
    bottom: 'calc(100% + 3px)',
    left: '0',
    transform: 'translate(-4px, 2px)',
    padding: '2px 6px',
    borderRadius: '4px',
    backgroundColor: 'inherit',
    color: '#ffffff',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '11px',
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.18)',
    opacity: '0',
    transition: 'opacity 120ms ease, transform 120ms ease',
  },
  '.cm-marklab-remote-caret-label-visible .cm-marklab-remote-caret-label': {
    opacity: '1',
    transform: 'translate(-4px, 0)',
  },
  '&.cm-marklab-remote-cursor-overlay-host': {
    position: 'relative',
  },
  '.cm-marklab-remote-cursor-label-layer': {
    position: 'absolute',
    inset: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    zIndex: '30',
    contain: 'layout style',
  },
  '.cm-marklab-remote-cursor-label-overlay': {
    position: 'absolute',
    padding: '2px 6px',
    borderRadius: '4px',
    color: '#ffffff',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '11px',
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.18)',
  },
});

function selectionRangesForRemoteCursor(
  view: EditorView,
  cursor: ResolvedRemoteCursorSelection,
  showLabel: boolean,
  renderInlineLabel = true,
): Range<Decoration>[] {
  const docLength = view.state.doc.length;
  if (cursor.anchor > docLength || cursor.head > docLength) return [];

  const ranges: Range<Decoration>[] = [];
  const start = Math.min(cursor.anchor, cursor.head);
  const end = Math.max(cursor.anchor, cursor.head);

  if (start < end) {
    const startLine = view.state.doc.lineAt(start);
    const endLine = view.state.doc.lineAt(end);
    const selectionDecoration = Decoration.mark({
      class: 'cm-marklab-remote-selection',
      attributes: { style: `background-color: ${cursor.colorLight}` },
    });

    if (startLine.number === endLine.number) {
      ranges.push(selectionDecoration.range(start, end));
    } else {
      if (start < startLine.to) ranges.push(selectionDecoration.range(start, startLine.to));
      if (endLine.from < end) ranges.push(selectionDecoration.range(endLine.from, end));
      for (let lineNumber = startLine.number + 1; lineNumber < endLine.number; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        ranges.push(Decoration.line({
          attributes: {
            class: 'cm-marklab-remote-line-selection',
            style: `background-color: ${cursor.colorLight}`,
          },
        }).range(line.from));
      }
    }
  }

  ranges.push(Decoration.widget({
    side: cursor.head >= cursor.anchor ? -1 : 1,
    widget: new RemoteCaretWidget(
      cursor.color,
      cursor.name,
      showLabel,
      [cursor.clientId, cursor.anchor, cursor.head].join('|'),
      renderInlineLabel,
    ),
  }).range(cursor.head));

  return ranges;
}

function buildRemoteCursorDecorationSet(
  view: EditorView,
  cursors: ResolvedRemoteCursorSelection[],
  isLabelVisible: ((cursor: ResolvedRemoteCursorSelection) => boolean) | undefined,
  renderInlineLabel = true,
): DecorationSet {
  const ranges = cursors
    .flatMap((cursor) => selectionRangesForRemoteCursor(
      view,
      cursor,
      renderInlineLabel && (isLabelVisible?.(cursor) ?? true),
      renderInlineLabel,
    ))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges, true);
}

export function buildRemoteCursorDecorations(
  view: EditorView,
  ytext: Y.Text,
  states: ReadonlyMap<number, MarkLabAwarenessState>,
  localClientId: number,
  visibleLabelClientIds?: ReadonlySet<number>,
): DecorationSet {
  return buildRemoteCursorDecorationSet(
    view,
    resolveRemoteCursorSelections(ytext, states, localClientId),
    visibleLabelClientIds ? (cursor) => visibleLabelClientIds.has(cursor.clientId) : undefined,
  );
}

interface AwarenessChangeEvent {
  added: number[];
  updated: number[];
  removed: number[];
}

export function createRemoteCursorExtension(input: {
  awareness: Awareness;
  ytext: Y.Text;
  localClientId: number;
  labelMode?: RemoteCursorLabelMode;
  labelRenderer?: RemoteCursorLabelRenderer;
}): Extension {
  const remoteCursorRefresh = Annotation.define<boolean>();
  const labelMode = input.labelMode ?? 'transient';
  const labelRenderer = input.labelRenderer ?? 'inline';
  const cursorSignature = (cursor: ResolvedRemoteCursorSelection): string => [
    cursor.anchor,
    cursor.head,
    cursor.name,
    cursor.color,
    cursor.colorLight,
    cursor.kind,
    cursor.clientKind ?? '',
  ].join('|');

  return [
    markLabRemoteCursorTheme,
    ViewPlugin.fromClass(class implements PluginValue {
      decorations: DecorationSet;
      private readonly onAwarenessChange: (event: AwarenessChangeEvent) => void;
      private readonly cursorSignatures = new Map<number, string>();
      private readonly labelVisibleUntil = new Map<string, number>();
      private labelTimer: ReturnType<typeof setTimeout> | null = null;
      private overlayLabelLayer: HTMLElement | null = null;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.markChangedCursorLabels(
          this.resolveCursors(),
          new Set(this.resolveCursors().map((cursor) => cursor.clientId)),
        );
        this.decorations = this.buildDecorations(this.view);
        this.onAwarenessChange = (event) => {
          const changedClientIds = new Set(
            [...event.added, ...event.updated].filter((clientId) => clientId !== input.localClientId),
          );
          const removedClientIds = event.removed.filter((clientId) => clientId !== input.localClientId);
          if (changedClientIds.size === 0 && removedClientIds.length === 0) return;
          for (const clientId of removedClientIds) {
            this.cursorSignatures.delete(clientId);
          }
          this.markChangedCursorLabels(this.resolveCursors(), changedClientIds);
          this.view.dispatch({ annotations: remoteCursorRefresh.of(true) });
        };
        input.awareness.on('change', this.onAwarenessChange);
      }

      update(update: ViewUpdate): void {
        const shouldRebuild = update.docChanged
          || update.viewportChanged
          || update.transactions.some((transaction) => transaction.annotation(remoteCursorRefresh));
        if (!shouldRebuild) return;
        this.decorations = this.buildDecorations(update.view);
      }

      destroy(): void {
        this.destroyed = true;
        if (this.labelTimer) {
          clearTimeout(this.labelTimer);
          this.labelTimer = null;
        }
        this.removeOverlayLabelLayer();
        input.awareness.off('change', this.onAwarenessChange);
      }

      private resolveCursors(): ResolvedRemoteCursorSelection[] {
        return resolveRemoteCursorSelections(
          input.ytext,
          input.awareness.getStates() as ReadonlyMap<number, MarkLabAwarenessState>,
          input.localClientId,
          { meta: awarenessClientMeta(input.awareness) },
        );
      }

      private markChangedCursorLabels(
        cursors: ResolvedRemoteCursorSelection[],
        changedClientIds: ReadonlySet<number>,
      ): void {
        if (changedClientIds.size === 0) return;
        const cursorByClientId = new Map(cursors.map((cursor) => [cursor.clientId, cursor]));
        const now = Date.now();
        for (const clientId of changedClientIds) {
          const cursor = cursorByClientId.get(clientId);
          if (!cursor) {
            this.cursorSignatures.delete(clientId);
            continue;
          }
          const nextSignature = cursorSignature(cursor);
          if (this.cursorSignatures.get(clientId) === nextSignature) continue;
          this.cursorSignatures.set(clientId, nextSignature);
          this.labelVisibleUntil.set(participantIdentityKey(cursor), now + remoteCursorLabelVisibleMs);
        }
      }

      private visibleLabelIdentityKeys(): Set<string> {
        const now = Date.now();
        const visible = new Set<string>();
        for (const [identityKey, visibleUntil] of this.labelVisibleUntil) {
          if (visibleUntil > now) {
            visible.add(identityKey);
          } else {
            this.labelVisibleUntil.delete(identityKey);
          }
        }
        return visible;
      }

      private buildDecorations(view: EditorView): DecorationSet {
        const visibleLabelIdentityKeys = this.visibleLabelIdentityKeys();
        const isLabelVisible = (cursor: ResolvedRemoteCursorSelection) => (
          labelMode === 'always' || visibleLabelIdentityKeys.has(participantIdentityKey(cursor))
        );
        const cursors = this.resolveCursors();
        const decorations = buildRemoteCursorDecorationSet(
          view,
          cursors,
          isLabelVisible,
          labelRenderer === 'inline',
        );
        if (labelRenderer === 'overlay') {
          this.syncOverlayLabels(view, cursors, isLabelVisible);
        } else {
          this.removeOverlayLabelLayer();
        }
        this.scheduleLabelExpiry();
        return decorations;
      }

      private ensureOverlayLabelLayer(view: EditorView): HTMLElement {
        if (this.overlayLabelLayer?.isConnected) return this.overlayLabelLayer;
        view.dom.classList.add('cm-marklab-remote-cursor-overlay-host');
        const layer = view.dom.ownerDocument.createElement('div');
        layer.className = 'cm-marklab-remote-cursor-label-layer';
        view.dom.append(layer);
        this.overlayLabelLayer = layer;
        return layer;
      }

      private removeOverlayLabelLayer(): void {
        this.overlayLabelLayer?.remove();
        this.overlayLabelLayer = null;
        this.view?.dom.classList.remove('cm-marklab-remote-cursor-overlay-host');
      }

      private syncOverlayLabels(
        view: EditorView,
        cursors: ResolvedRemoteCursorSelection[],
        isLabelVisible: (cursor: ResolvedRemoteCursorSelection) => boolean,
      ): void {
        const visibleCursors = cursors.filter(isLabelVisible);
        if (visibleCursors.length === 0) {
          if (this.overlayLabelLayer) this.overlayLabelLayer.replaceChildren();
          return;
        }

        const layer = this.ensureOverlayLabelLayer(view);
        const editorRect = view.dom.getBoundingClientRect();
        const labels = visibleCursors.flatMap((cursor) => {
          const side = cursor.head >= cursor.anchor ? -1 : 1;
          const coords = view.coordsAtPos(cursor.head, side) ?? view.coordsAtPos(cursor.head);
          if (!coords) return [];
          const label = view.dom.ownerDocument.createElement('div');
          label.className = 'cm-marklab-remote-cursor-label-overlay';
          label.textContent = cursor.name;
          label.style.backgroundColor = cursor.color;
          label.style.left = `${Math.round(coords.left - editorRect.left - 4)}px`;
          label.style.top = `${Math.round(coords.top - editorRect.top - 21)}px`;
          return [label];
        });
        layer.replaceChildren(...labels);
      }

      private scheduleLabelExpiry(): void {
        if (this.labelTimer) {
          clearTimeout(this.labelTimer);
          this.labelTimer = null;
        }
        const now = Date.now();
        let nextExpiry: number | null = null;
        for (const visibleUntil of this.labelVisibleUntil.values()) {
          if (visibleUntil <= now) continue;
          if (nextExpiry === null || visibleUntil < nextExpiry) nextExpiry = visibleUntil;
        }
        if (nextExpiry === null) return;
        this.labelTimer = setTimeout(() => {
          this.labelTimer = null;
          if (this.destroyed) return;
          this.view.dispatch({ annotations: remoteCursorRefresh.of(true) });
        }, Math.max(0, nextExpiry - now + 1));
      }
    }, {
      decorations: (plugin) => plugin.decorations,
    }),
  ];
}
