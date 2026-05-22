import { CollaborativeMarkdownEditor } from './editor/CollaborativeMarkdownEditor';
import { ReadOnlyMarkdownView } from './editor/ReadOnlyMarkdownView';
import { WorkspaceSettings } from './workspaces/WorkspaceSettings';
import { AuthCallbackPage, SignInPage } from './auth/AuthFlow';

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

export function collabNativeShellFromParam(value: string | null, nativeApp = window.__marklabNativeApp === true): 'markedit' | undefined {
  return value === 'markedit' && nativeApp ? 'markedit' : undefined;
}

export function App() {
  const path = window.location.pathname;

  if (path === '/signin' || path === '/signin/') {
    return <SignInPage nativeMode={searchParam('native') === '1'} />;
  }

  if (path === '/auth/callback' || path === '/auth/callback/') {
    return <AuthCallbackPage />;
  }

  if (path.match(/^\/workspaces\/[^/]+\/settings\/?$/u)) {
    const workspaceId = path.split('/')[2] ?? '';
    return <WorkspaceSettings workspaceId={workspaceId} />;
  }

  const mode = searchParam('mode') === 'view' ? 'view' : 'edit';
  const docId = searchParam('docId') ?? '';
  const branchId = searchParam('branchId') ?? '';
  const token = searchParam('token') ?? undefined;
  const clientKind = collabClientKindFromParam(searchParam('clientKind'));
  const nativeShell = collabNativeShellFromParam(searchParam('nativeShell'));
  const displayName = searchParam('name') ?? undefined;

  if (mode === 'view') {
    return <ReadOnlyMarkdownView docId={docId} branchId={branchId} token={token} displayName={displayName} />;
  }

  return <CollaborativeMarkdownEditor docId={docId} branchId={branchId} token={token} displayName={displayName} clientKind={clientKind} nativeShell={nativeShell} />;
}
