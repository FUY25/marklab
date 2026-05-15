import { describe, expect, it } from 'vitest';
import { buildCollabDocumentPath } from './routes';

describe('browser collaboration routes', () => {
  it('builds formal collab-web document routes for generated access links', () => {
    const url = new URL(buildCollabDocumentPath('doc 1', 'branch/main'), 'https://marklab.example');

    expect(url.pathname).toBe('/collab');
    expect(url.searchParams.get('docId')).toBe('doc 1');
    expect(url.searchParams.get('branchId')).toBe('branch/main');
  });
});
