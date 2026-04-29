import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from './canonicalize';
import { fixtureNames, readFixture } from './fixtures';

describe('Markdown fixtures are canonicalization-stable', () => {
  for (const fixtureName of fixtureNames) {
    it(`${fixtureName} is stable after repeated canonicalization`, async () => {
      const raw = await readFixture(fixtureName);
      const once = await canonicalizeMarkdown(raw);
      const twice = await canonicalizeMarkdown(once);
      expect(twice).toBe(once);
    });
  }
});
