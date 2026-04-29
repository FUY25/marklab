import { describe, expect, it } from 'vitest';
import { buildExportFilename } from './export-filename';

describe('buildExportFilename', () => {
  it('builds metadata-rich snapshot filename', () => {
    const name = buildExportFilename({
      title: 'Strategy Memo!',
      docId: 'doc_a13f9c999',
      branchSlug: 'main',
      versionNumber: 43,
      exportedAt: new Date('2026-04-29T15:30:12Z'),
      hash: 'sha256:7b91a2cf999999999',
    });

    expect(name).toBe(
      'strategy-memo__EXPORT__doc-a13f9c__branch-main__v0043__20260429-153012Z__sha-7b91a2cf__check-cloud-before-use.md',
    );
  });
});
