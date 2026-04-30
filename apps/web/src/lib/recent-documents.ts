export interface RecentDocument {
  docId: string;
  branchId: string;
  title: string;
  openedAt: string;
}

const recentDocumentsKey = 'marklab.recentDocuments.v1';
const maxRecentDocuments = 10;

function isRecentDocument(value: unknown): value is RecentDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecentDocument>;
  return (
    typeof candidate.docId === 'string' &&
    candidate.docId.length > 0 &&
    typeof candidate.branchId === 'string' &&
    candidate.branchId.length > 0 &&
    typeof candidate.title === 'string' &&
    typeof candidate.openedAt === 'string'
  );
}

export function loadRecentDocuments(storage: Storage = localStorage): RecentDocument[] {
  try {
    const raw = storage.getItem(recentDocumentsKey);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isRecentDocument).slice(0, maxRecentDocuments);
  } catch {
    return [];
  }
}

export function rememberRecentDocument(
  document: Omit<RecentDocument, 'openedAt'> & Partial<Pick<RecentDocument, 'openedAt'>>,
  storage: Storage = localStorage,
): RecentDocument[] {
  const nextDocument: RecentDocument = {
    ...document,
    title: document.title.trim() || document.docId,
    openedAt: document.openedAt ?? new Date().toISOString(),
  };
  const deduped = loadRecentDocuments(storage).filter(
    (item) => item.docId !== nextDocument.docId || item.branchId !== nextDocument.branchId,
  );
  const nextDocuments = [nextDocument, ...deduped].slice(0, maxRecentDocuments);

  try {
    storage.setItem(recentDocumentsKey, JSON.stringify(nextDocuments));
  } catch {
    // Local storage can be unavailable in private browsing or quota-constrained sessions.
  }

  return nextDocuments;
}
