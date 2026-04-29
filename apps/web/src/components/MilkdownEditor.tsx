import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { historyKeymap } from '@milkdown/kit/plugin/history';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export interface MilkdownEditorProps {
  initialMarkdown: string;
  ydoc: Doc;
  awareness: Awareness;
  className?: string;
  testId?: string;
  applyInitialTemplate?: boolean;
  onMarkdownChange?: (markdown: string, previousMarkdown: string) => void;
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
