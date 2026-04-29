export interface ExportFilenameInput {
  title: string;
  docId: string;
  branchSlug: string;
  versionNumber: number;
  exportedAt: Date;
  hash: string;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug.length > 0 ? slug : 'untitled';
}

function formatUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function buildExportFilename(input: ExportFilenameInput): string {
  const slug = slugify(input.title);
  const docShort = input.docId.replace(/^doc_/, '').slice(0, 6);
  const version = String(input.versionNumber).padStart(4, '0');
  const hash8 = input.hash.replace(/^sha256:/, '').slice(0, 8);

  return `${slug}__EXPORT__doc-${docShort}__branch-${input.branchSlug}__v${version}__${formatUtc(
    input.exportedAt,
  )}__sha-${hash8}__check-cloud-before-use.md`;
}
