import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('manifest', () => {
  it('is desktop-only and uses an Obsidian-compatible plugin id', async () => {
    const manifestPath = resolve(import.meta.dirname, '../manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      id: string;
      isDesktopOnly: boolean;
      description: string;
    };

    expect(manifest.id).toBe('marklab');
    expect(manifest.id).not.toContain('obsidian');
    expect(manifest.isDesktopOnly).toBe(true);
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description.endsWith('.')).toBe(true);
  });
});
