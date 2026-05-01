import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { historyKeymap } from '@milkdown/kit/plugin/history';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

interface RemoteAwarenessUser {
  name?: string;
  color?: string;
}

export interface MilkdownEditorProps {
  initialMarkdown: string;
  ydoc: Doc;
  awareness: Awareness;
  className?: string;
  testId?: string;
  applyInitialTemplate?: boolean;
  onMarkdownChange?: (markdown: string, previousMarkdown: string) => void;
}

function normalizeRemoteColor(color: string | undefined): string {
  return /^#[0-9a-fA-F]{6}$/u.test(color ?? '') ? color! : '#2563eb';
}

function buildRemoteCursor(user: RemoteAwarenessUser) {
  const color = normalizeRemoteColor(user.color);
  const label = user.name?.trim();
  const cursor = document.createElement('span');
  cursor.classList.add('ProseMirror-yjs-cursor', 'marklab-collab-cursor');
  cursor.style.borderColor = color;
  cursor.style.setProperty('--marklab-collab-color', color);
  cursor.setAttribute('aria-hidden', 'true');
  if (label) {
    const labelElement = document.createElement('span');
    labelElement.classList.add('marklab-collab-cursor-label');
    labelElement.textContent = label;
    labelElement.style.backgroundColor = color;
    cursor.append(labelElement);
  }
  return cursor;
}

function buildRemoteSelection(user: RemoteAwarenessUser) {
  const color = normalizeRemoteColor(user.color);
  return {
    class: 'ProseMirror-yjs-selection marklab-collab-selection',
    style: `background-color: ${color}33`,
  };
}

export function MilkdownEditor({
  initialMarkdown,
  ydoc,
  awareness,
  className,
  testId,
  applyInitialTemplate = true,
  onMarkdownChange,
}: MilkdownEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onMarkdownChangeRef = useRef(onMarkdownChange);

  useEffect(() => {
    onMarkdownChangeRef.current = onMarkdownChange;
  }, [onMarkdownChange]);

  useEffect(() => {
    if (!rootRef.current) return;

    let disposed = false;
    let crepe: Crepe | undefined;

    async function createEditor() {
      const instance = new Crepe({
        root: rootRef.current,
        defaultValue: initialMarkdown,
        features: {
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.ImageBlock]: false,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: 'Start writing...',
            mode: 'block',
          },
        },
      });

      instance.editor
        .config((ctx) => {
          ctx.set(historyKeymap.key, {
            Undo: { shortcuts: [] },
            Redo: { shortcuts: [] },
          });
        })
        .use(collab);

      instance.on((listener) => {
        listener.markdownUpdated((_ctx, markdown, previousMarkdown) => {
          onMarkdownChangeRef.current?.(markdown, previousMarkdown);
        });
      });

      await instance.create();
      crepe = instance;

      if (disposed) {
        instance.destroy();
        return;
      }

      instance.editor.action((ctx) => {
        const service = ctx
          .get(collabServiceCtx)
          .bindDoc(ydoc);

        service.mergeOptions({
          yCursorOpts: {
            cursorBuilder: buildRemoteCursor,
            selectionBuilder: buildRemoteSelection,
          },
        });

        if (applyInitialTemplate) service.applyTemplate(initialMarkdown);

        service.setAwareness(awareness).connect();
      });
    }

    void createEditor();

    return () => {
      disposed = true;
      crepe?.destroy();
    };
  }, [applyInitialTemplate, awareness, initialMarkdown, testId, ydoc]);

  return <div ref={rootRef} className={className ?? 'milkdown-editor'} data-testid={testId ?? 'milkdown-editor'} />;
}
