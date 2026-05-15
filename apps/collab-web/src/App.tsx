import { CollaborativeMarkdownEditor } from './editor/CollaborativeMarkdownEditor';
import { ReadOnlyMarkdownView } from './editor/ReadOnlyMarkdownView';
import { WorkspaceSettings } from './workspaces/WorkspaceSettings';

function searchParam(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

declare global {
  interface Window {
    __marklabNativeApp?: boolean;
  }
}

export function collabClientKindFromParam(value: string | null, nativeApp = window.__marklabNativeApp === true): 'browser' | 'app' {
  return value === 'app' && nativeApp ? 'app' : 'browser';
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
  const clientKind = collabClientKindFromParam(searchParam('clientKind'));

  if (mode === 'view') {
    return <ReadOnlyMarkdownView docId={docId} branchId={branchId} token={token} />;
  }

  return <CollaborativeMarkdownEditor docId={docId} branchId={branchId} token={token} clientKind={clientKind} />;
}
