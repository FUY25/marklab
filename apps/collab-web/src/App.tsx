import { CollaborativeMarkdownEditor } from './editor/CollaborativeMarkdownEditor';
import { ReadOnlyMarkdownView } from './editor/ReadOnlyMarkdownView';
import { WorkspaceSettings } from './workspaces/WorkspaceSettings';

function searchParam(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

export function App() {
  const path = window.location.pathname;

  if (path.match(/^\/workspaces\/[^/]+\/settings\/?$/u)) {
    const workspaceId = path.split('/')[2] ?? '';
    return <WorkspaceSettings workspaceId={workspaceId} />;
  }

  const mode = searchParam('mode') === 'view' ? 'view' : 'edit';
  const docId = searchParam('docId') ?? '';
  const branchId = searchParam('branchId') ?? '';
  const token = searchParam('token') ?? undefined;

  if (mode === 'view') {
    return <ReadOnlyMarkdownView docId={docId} branchId={branchId} token={token} />;
  }

  return <CollaborativeMarkdownEditor docId={docId} branchId={branchId} token={token} />;
}
