import { describe, expect, it } from 'vitest';
import { createUnavailableLiveMarkdownWriter } from './live-writer';

describe('createUnavailableLiveMarkdownWriter', () => {
  it('fails closed instead of falling back to mirror-only writes', async () => {
    const writer = createUnavailableLiveMarkdownWriter();

    await expect(
      writer.applyMarkdownTransaction({
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Target\n',
        operation: { kind: 'write', baseVersionId: 'ver_001', baseHash: 'sha256:current' },
      }),
    ).rejects.toThrow('live_writer_not_configured');
  });

  it('fails closed for observed exact edits too', async () => {
    const writer = createUnavailableLiveMarkdownWriter();

    await expect(
      writer.applyMarkdownTransaction({
        branchId: 'br_main',
        targetCanonicalMarkdown: '# Target\n',
        operation: {
          kind: 'edit',
          observedVersionId: 'ver_seen',
          oldString: 'Old',
          newString: 'New',
          replaceAll: false,
        },
      }),
    ).rejects.toThrow('live_writer_not_configured');
  });
});
