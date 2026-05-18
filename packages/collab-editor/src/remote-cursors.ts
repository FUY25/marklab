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

function awarenessRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function safeAwarenessColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/iu.test(value)) return value;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/iu.test(value)) return value;
  return fallback;
}

export function summarizeRemoteCursors(states: ReadonlyMap<number, MarkLabAwarenessState>, localClientId: number): RemoteCursorSummary[] {
  return [...states.entries()]
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
}

export function resolveRemoteCursorSelections(
  ytext: Y.Text,
  states: ReadonlyMap<number, MarkLabAwarenessState>,
  localClientId: number,
): ResolvedRemoteCursorSelection[] {
  return [...states.entries()].flatMap(([clientId, state]) => {
    if (clientId === localClientId) return [];
    const cursor = resolveCursorAwareness(ytext, state);
    if (!cursor) return [];
    return [{
      clientId,
      name: cursor.user.name,
      color: safeAwarenessColor(cursor.user.color, '#2563eb'),
      colorLight: safeAwarenessColor(cursor.user.colorLight, '#dbeafe'),
      kind: cursor.user.kind,
      ...(cursor.user.clientKind ? { clientKind: cursor.user.clientKind } : {}),
      anchor: cursor.anchor,
      head: cursor.head,
    }];
  });
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const caret = view.dom.ownerDocument.createElement('span');
    caret.className = 'cm-marklab-remote-caret';
    caret.style.borderColor = this.color;
    caret.style.backgroundColor = this.color;

    const dot = view.dom.ownerDocument.createElement('span');
    dot.className = 'cm-marklab-remote-caret-dot';
    caret.append(dot);

    const label = view.dom.ownerDocument.createElement('span');
    label.className = 'cm-marklab-remote-caret-label';
    label.textContent = this.name;
    caret.append(label);

    return caret;
  }

  eq(other: RemoteCaretWidget): boolean {
    return this.color === other.color && this.name === other.name;
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
    transform: 'translateX(-4px)',
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
  },
});

function selectionRangesForRemoteCursor(view: EditorView, cursor: ResolvedRemoteCursorSelection): Range<Decoration>[] {
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
    widget: new RemoteCaretWidget(cursor.color, cursor.name),
  }).range(cursor.head));

  return ranges;
}

export function buildRemoteCursorDecorations(
  view: EditorView,
  ytext: Y.Text,
  states: ReadonlyMap<number, MarkLabAwarenessState>,
  localClientId: number,
): DecorationSet {
  const ranges = resolveRemoteCursorSelections(ytext, states, localClientId)
    .flatMap((cursor) => selectionRangesForRemoteCursor(view, cursor))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(ranges, true);
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
}): Extension {
  const remoteCursorRefresh = Annotation.define<boolean>();

  return [
    markLabRemoteCursorTheme,
    ViewPlugin.fromClass(class implements PluginValue {
      decorations: DecorationSet;
      private readonly onAwarenessChange: (event: AwarenessChangeEvent) => void;

      constructor(private readonly view: EditorView) {
        this.decorations = buildRemoteCursorDecorations(
          this.view,
          input.ytext,
          input.awareness.getStates() as ReadonlyMap<number, MarkLabAwarenessState>,
          input.localClientId,
        );
        this.onAwarenessChange = (event) => {
          if ([...event.added, ...event.updated, ...event.removed].some((clientId) => clientId !== input.localClientId)) {
            this.view.dispatch({ annotations: remoteCursorRefresh.of(true) });
          }
        };
        input.awareness.on('change', this.onAwarenessChange);
      }

      update(update: ViewUpdate): void {
        const shouldRebuild = update.docChanged
          || update.viewportChanged
          || update.transactions.some((transaction) => transaction.annotation(remoteCursorRefresh));
        if (!shouldRebuild) return;
        this.decorations = buildRemoteCursorDecorations(
          update.view,
          input.ytext,
          input.awareness.getStates() as ReadonlyMap<number, MarkLabAwarenessState>,
          input.localClientId,
        );
      }

      destroy(): void {
        input.awareness.off('change', this.onAwarenessChange);
      }
    }, {
      decorations: (plugin) => plugin.decorations,
    }),
  ];
}
