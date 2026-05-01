export type AppRoute =
  | { kind: 'remote-document'; docId: string; branchId: string }
  | { kind: 'relay-document'; relayRoomId: string }
  | { kind: 'local-document' }
  | { kind: 'local-single' }
  | { kind: 'local-two' }
  | { kind: 'home' };

function decodePathPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseAppRoute(location: Pick<Location, 'pathname' | 'search'>): AppRoute {
  const pathParts = location.pathname.split('/').filter(Boolean);
  const [docsSegment, docIdSegment, branchesSegment, branchIdSegment] = pathParts;
  if (pathParts.length === 2 && pathParts[0] === 'relay') {
    const relayRoomId = decodePathPart(pathParts[1] ?? '');
    if (relayRoomId) return { kind: 'relay-document', relayRoomId };
  }

  const docId = docIdSegment ? decodePathPart(docIdSegment) : null;
  const branchId = branchIdSegment ? decodePathPart(branchIdSegment) : null;
  if (
    pathParts.length === 4 &&
    docsSegment === 'docs' &&
    docId &&
    branchesSegment === 'branches' &&
    branchId
  ) {
    return {
      kind: 'remote-document',
      docId,
      branchId,
    };
  }

  const params = new URLSearchParams(location.search);
  const queryDocId = params.get('docId');
  const queryBranchId = params.get('branchId');
  if (queryDocId && queryBranchId) return { kind: 'remote-document', docId: queryDocId, branchId: queryBranchId };

  if (pathParts.length === 1 && pathParts[0] === 'local') return { kind: 'local-document' };

  if (params.get('local') === 'one') return { kind: 'local-single' };

  if (params.get('collab') === 'two') return { kind: 'local-two' };

  return { kind: 'home' };
}

export function buildDocumentPath(docId: string, branchId: string): string {
  return `/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}`;
}

export function buildLocalDocumentPath(): string {
  return '/local';
}

export function buildRelayDocumentPath(relayRoomId: string): string {
  return `/relay/${encodeURIComponent(relayRoomId)}`;
}
