export type AppRoute =
  | { kind: 'remote-document'; docId: string; branchId: string }
  | { kind: 'local-single' }
  | { kind: 'local-two' };

function decodePathPart(value: string): string {
  return decodeURIComponent(value);
}

export function parseAppRoute(location: Pick<Location, 'pathname' | 'search'>): AppRoute {
  const pathParts = location.pathname.split('/').filter(Boolean);
  const [docsSegment, docIdSegment, branchesSegment, branchIdSegment] = pathParts;
  if (
    pathParts.length === 4 &&
    docsSegment === 'docs' &&
    docIdSegment &&
    branchesSegment === 'branches' &&
    branchIdSegment
  ) {
    return {
      kind: 'remote-document',
      docId: decodePathPart(docIdSegment),
      branchId: decodePathPart(branchIdSegment),
    };
  }

  const params = new URLSearchParams(location.search);
  const docId = params.get('docId');
  const branchId = params.get('branchId');
  if (docId && branchId) return { kind: 'remote-document', docId, branchId };

  if (params.get('collab') === 'two') return { kind: 'local-two' };

  return { kind: 'local-single' };
}

export function buildDocumentPath(docId: string, branchId: string): string {
  return `/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}`;
}
