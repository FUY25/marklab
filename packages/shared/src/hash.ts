import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}
