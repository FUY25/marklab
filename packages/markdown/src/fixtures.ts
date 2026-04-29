import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fixtureNames = [
  '01_basic.md',
  '02_table.md',
  '03_code_mermaid_frontmatter.md',
  '04_math_links_images.md',
] as const;

export type FixtureName = (typeof fixtureNames)[number];

export async function readFixture(name: FixtureName): Promise<string> {
  return readFile(join(process.cwd(), 'fixtures', name), 'utf8');
}
