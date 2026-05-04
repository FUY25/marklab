export function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');
}
