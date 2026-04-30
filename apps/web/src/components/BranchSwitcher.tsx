import { useEffect, useMemo, useState } from 'react';
import { MarklabWebApi, type BranchSummary } from '../lib/api-client';
import { buildDocumentPath } from '../routes';

interface BranchSwitcherProps {
  docId: string;
  branchId: string;
}

function branchLabel(branch: BranchSummary): string {
  const name = branch.slug || branch.name || branch.branchId;
  const suffix = branch.headVersionNumber ? ` v${branch.headVersionNumber}` : ' no versions';
  return `${name}${branch.isArchived ? ' archived' : ''} (${suffix})`;
}

export function BranchSwitcher({ docId, branchId }: BranchSwitcherProps) {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;
    setIsLoading(true);
    setError(null);

    void api
      .listBranches(docId)
      .then((response) => {
        if (!isActive) return;
        setBranches(response.branches);
      })
      .catch((loadError: unknown) => {
        if (!isActive) return;
        setError(loadError instanceof Error ? loadError.message : 'Unable to load branches.');
      })
      .finally(() => {
        if (isActive) setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [api, docId]);

  function handleBranchChange(nextBranchId: string) {
    if (!nextBranchId || nextBranchId === branchId) return;
    window.location.assign(buildDocumentPath(docId, nextBranchId));
  }

  return (
    <section className="branch-switcher" data-testid="branch-switcher" aria-label="Branch switcher">
      <label htmlFor="branch-switcher-select">Branch</label>
      <select
        id="branch-switcher-select"
        aria-label="Branch"
        value={branchId}
        disabled={isLoading || branches.length === 0}
        onChange={(event) => handleBranchChange(event.currentTarget.value)}
      >
        {branches.some((branch) => branch.branchId === branchId) ? null : <option value={branchId}>{branchId}</option>}
        {branches.map((branch) => (
          <option key={branch.branchId} value={branch.branchId} disabled={branch.isArchived}>
            {branchLabel(branch)}
          </option>
        ))}
      </select>
      <span className="branch-switcher-status" role={error ? 'alert' : 'status'}>
        {error ?? (isLoading ? 'Loading branches...' : `${branches.length} branch${branches.length === 1 ? '' : 'es'}`)}
      </span>
    </section>
  );
}
