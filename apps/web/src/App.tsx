import { useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { MilkdownEditor } from './components/MilkdownEditor';
import { RemoteDocumentPage } from './pages/RemoteDocumentPage';
import { parseAppRoute } from './routes';

const initialMarkdown = '# MarkLab\n\nEdit this collaborative Markdown document.\n';
const remoteBridgeOrigin = 'remote-test-bridge';

function createAwareness(doc: Y.Doc, name: string, color: string) {
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name, color });
  return awareness;
}

function createLinkedDocs() {
  const leftDoc = new Y.Doc();
  const rightDoc = new Y.Doc();

  leftDoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === remoteBridgeOrigin) return;
    Y.applyUpdate(rightDoc, update, remoteBridgeOrigin);
  });

  rightDoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === remoteBridgeOrigin) return;
    Y.applyUpdate(leftDoc, update, remoteBridgeOrigin);
  });

  return {
    leftDoc,
    rightDoc,
    leftAwareness: createAwareness(leftDoc, 'Writer A', '#2563eb'),
    rightAwareness: createAwareness(rightDoc, 'Writer B', '#16a34a'),
  };
}

export function App() {
  const route = parseAppRoute(window.location);

  if (route.kind === 'remote-document') {
    return <RemoteDocumentPage docId={route.docId} branchId={route.branchId} />;
  }

  if (route.kind === 'local-two') return <TwoEditorCollabHarness />;

  return <SingleEditorWorkspace />;
}

function SingleEditorWorkspace() {
  const ydoc = useMemo(() => new Y.Doc(), []);
  const awareness = useMemo(() => createAwareness(ydoc, 'Human Writer', '#2563eb'), [ydoc]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>MarkLab</h1>
      </header>
      <MilkdownEditor initialMarkdown={initialMarkdown} ydoc={ydoc} awareness={awareness} />
    </main>
  );
}

function TwoEditorCollabHarness() {
  const linked = useMemo(createLinkedDocs, []);
  const [leftMarkdown, setLeftMarkdown] = useState('');
  const [rightMarkdown, setRightMarkdown] = useState('');

  return (
    <main className="app-shell app-shell-wide">
      <header className="app-header">
        <h1>MarkLab</h1>
      </header>
      <section className="collab-grid" aria-label="Collaborative editor test harness">
        <div className="collab-pane">
          <h2>Writer A</h2>
          <MilkdownEditor
            initialMarkdown={initialMarkdown}
            ydoc={linked.leftDoc}
            awareness={linked.leftAwareness}
            testId="milkdown-editor-left"
            onMarkdownChange={(markdown) => setLeftMarkdown(markdown)}
          />
        </div>
        <div className="collab-pane">
          <h2>Writer B</h2>
          <MilkdownEditor
            initialMarkdown={initialMarkdown}
            ydoc={linked.rightDoc}
            awareness={linked.rightAwareness}
            testId="milkdown-editor-right"
            applyInitialTemplate={false}
            onMarkdownChange={(markdown) => setRightMarkdown(markdown)}
          />
        </div>
      </section>
      <output className="markdown-debug" data-testid="markdown-left">
        {leftMarkdown}
      </output>
      <output className="markdown-debug" data-testid="markdown-right">
        {rightMarkdown}
      </output>
    </main>
  );
}
