import { useMemo, useState } from 'react';
import { MarklabWebApi } from '../lib/api-client';
import { buildDocumentPath } from '../routes';

interface DocumentToolbarProps {
  docId: string;
  branchId: string;
}

export function DocumentToolbar({ docId, branchId }: DocumentToolbarProps) {
  const api = useMemo(() => new MarklabWebApi(), []);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'status' | 'alert'>('status');
  const [isExporting, setIsExporting] = useState(false);
  const documentPath = buildDocumentPath(docId, branchId);

  async function copyLink() {
    setStatus(null);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${documentPath}`);
      setStatusKind('status');
      setStatus('Link copied.');
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.');
    }
  }

  async function exportMarkdown() {
    setIsExporting(true);
    setStatus(null);
    try {
      const exported = await api.exportMarkdown(docId, branchId);
      const blob = new Blob([exported.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatusKind('status');
      setStatus(`Exported ${exported.filename}.`);
    } catch (error) {
      setStatusKind('alert');
      setStatus(error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <nav className="document-toolbar" aria-label="Document toolbar">
      <a href="/">Documents</a>
      <button type="button" onClick={() => void copyLink()}>
        Copy link
      </button>
      <button type="button" onClick={() => void exportMarkdown()} disabled={isExporting}>
        {isExporting ? 'Exporting...' : 'Export Markdown'}
      </button>
      <span className="document-toolbar-status" role={statusKind}>
        {status}
      </span>
    </nav>
  );
}
