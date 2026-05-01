import { useEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';

export interface ReadOnlyMarkdownViewProps {
  markdown: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}

export function ReadOnlyMarkdownView({
  markdown,
  className,
  testId,
  ariaLabel = 'Read-only Markdown document',
}: ReadOnlyMarkdownViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const root = rootRef.current;

    let disposed = false;
    let crepe: Crepe | undefined;

    async function createReadOnlyView() {
      const instance = new Crepe({
        root,
        defaultValue: markdown,
        features: {
          [Crepe.Feature.BlockEdit]: false,
          [Crepe.Feature.Cursor]: false,
          [Crepe.Feature.ImageBlock]: false,
          [Crepe.Feature.Placeholder]: false,
          [Crepe.Feature.Toolbar]: false,
          [Crepe.Feature.TopBar]: false,
        },
      });

      instance.setReadonly(true);
      await instance.create();
      crepe = instance;
      instance.setReadonly(true);

      if (disposed) void instance.destroy();
    }

    void createReadOnlyView();

    return () => {
      disposed = true;
      void crepe?.destroy();
    };
  }, [markdown]);

  return (
    <article
      ref={rootRef}
      className={className ?? 'read-only-document'}
      data-testid={testId ?? 'read-only-document'}
      aria-label={ariaLabel}
    />
  );
}
