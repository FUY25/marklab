// Code in this file has been adapted from y-codemirror.next.
// License: MIT License, Copyright (c) 2024 Kevin Jahns.

import { Annotation, StateEffect, Transaction, type ChangeSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import * as Y from 'yjs';

export const ySyncAnnotation = Annotation.define<boolean>();

export interface YTextCodeMirrorBindingOptions {
  view: EditorView;
  ytext: Y.Text;
  preferInitial?: 'ytext' | 'editor';
}

export interface YTextCodeMirrorBinding {
  destroy(): void;
}

export function createIndexedDbPersistenceKey(providerDocId: string, sessionId: string): string {
  return `marklab:collab-web:${providerDocId}:${sessionId}`;
}

function replaceEditorDocument(view: EditorView, text: string): void {
  const current = view.state.doc.toString();
  if (current === text) return;
  view.dispatch({
    annotations: [ySyncAnnotation.of(true), Transaction.addToHistory.of(false)],
    changes: { from: 0, to: current.length, insert: text },
  });
}

function yTextEventToChangeSpecs(event: Y.YTextEvent): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let position = 0;
  for (const delta of event.delta) {
    if (delta.insert != null) {
      const inserted = typeof delta.insert === 'string' ? delta.insert : String(delta.insert);
      if (inserted.length > 0) {
        changes.push({ from: position, to: position, insert: inserted });
      }
      continue;
    }
    if (delta.delete != null) {
      changes.push({ from: position, to: position + delta.delete, insert: '' });
      position += delta.delete;
      continue;
    }
    if (delta.retain != null) {
      position += delta.retain;
    }
  }
  return changes;
}

function applyYTextEventToEditor(view: EditorView, event: Y.YTextEvent): void {
  const changes = yTextEventToChangeSpecs(event);
  if (changes.length === 0) return;
  view.dispatch({
    annotations: [ySyncAnnotation.of(true), Transaction.addToHistory.of(false)],
    changes,
  });
}

function applyEditorChangesToYText(update: ViewUpdate, ytext: Y.Text, origin: unknown): void {
  if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(ySyncAnnotation))) return;

  ytext.doc?.transact(() => {
    let offset = 0;
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const deleteLength = toA - fromA;
      const index = fromA + offset;
      if (deleteLength > 0) ytext.delete(index, deleteLength);
      const insertedText = inserted.toString();
      if (insertedText) ytext.insert(index, insertedText);
      offset += insertedText.length - deleteLength;
    });
  }, origin);
}

export function createYTextCodeMirrorBinding(options: YTextCodeMirrorBindingOptions): YTextCodeMirrorBinding {
  const { view, ytext } = options;
  const preferInitial = options.preferInitial ?? 'ytext';
  let destroyed = false;
  const origin = { binding: 'marklab-ytext-codemirror' };

  if (preferInitial === 'editor' && ytext.length === 0 && view.state.doc.length > 0) {
    ytext.insert(0, view.state.doc.toString());
  } else {
    replaceEditorDocument(view, ytext.toString());
  }

  const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (destroyed || transaction.origin === origin) return;
    applyYTextEventToEditor(view, event);
  };
  ytext.observe(observer);

  const updateListener = EditorView.updateListener.of((update) => {
    if (destroyed) return;
    applyEditorChangesToYText(update, ytext, origin);
  });

  view.dispatch({
    effects: StateEffect.appendConfig.of(updateListener),
  });

  return {
    destroy() {
      destroyed = true;
      ytext.unobserve(observer);
    },
  };
}
