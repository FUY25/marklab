import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdown } from './canonicalize';

describe('canonicalizeMarkdown', () => {
  it('keeps table content and stabilizes formatting', async () => {
    const input = '# Table\n\n|A|B|\n|-|-|\n|1|2|\n';
    const output = await canonicalizeMarkdown(input);

    expect(output).toContain('| A   | B   |');
    expect(output).toContain('| 1   | 2   |');
  });

  it('preserves fenced code blocks', async () => {
    const input = '```mermaid\ngraph TD\n  A-->B\n```\n';
    const output = await canonicalizeMarkdown(input);

    expect(output).toContain('```mermaid');
    expect(output).toContain('graph TD');
  });
});
