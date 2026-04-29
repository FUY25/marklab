import { format } from 'prettier';

export async function canonicalizeMarkdown(markdown: string): Promise<string> {
  const formatted = await format(markdown, {
    parser: 'markdown',
    proseWrap: 'preserve',
    singleQuote: false,
  });

  return formatted.replace(/\s+$/u, '\n');
}
