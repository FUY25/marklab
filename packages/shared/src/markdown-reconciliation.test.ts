import { describe, expect, it } from 'vitest';
import { decideMarkdownReconciliation, normalizeCollabMarkdown } from './markdown-reconciliation';

describe('markdown reconciliation', () => {
  it('normalizes CRLF and CR at the collaboration boundary', () => {
    expect(normalizeCollabMarkdown('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('does nothing when disk and provider still match the baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Base\n',
      providerMarkdown: '# Base\n',
    })).toEqual({
      kind: 'noop',
      markdown: '# Base\n',
    });
  });

  it('projects provider content when only provider changed from the baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Base\n',
      providerMarkdown: '# Remote\n',
    })).toEqual({
      kind: 'project_provider_to_disk',
      markdown: '# Remote\n',
    });
  });

  it('ingests disk content when only disk changed from the baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Base\n',
    })).toEqual({
      kind: 'ingest_disk_to_provider',
      markdown: '# Local\n',
    });
  });

  it('accepts converged content when disk and provider independently changed to the same text', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Same\n',
      providerMarkdown: '# Same\n',
    })).toEqual({
      kind: 'accept_converged',
      markdown: '# Same\n',
    });
  });

  it('opens conflict when disk and provider diverged from the same baseline', () => {
    expect(decideMarkdownReconciliation({
      lastProjectedMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Remote\n',
    })).toEqual({
      kind: 'conflict',
      baseMarkdown: '# Base\n',
      diskMarkdown: '# Local\n',
      providerMarkdown: '# Remote\n',
    });
  });
});
