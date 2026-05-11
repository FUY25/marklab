export type MarkdownReconciliationDecision =
  | { kind: 'noop'; markdown: string }
  | { kind: 'accept_converged'; markdown: string }
  | { kind: 'project_provider_to_disk'; markdown: string }
  | { kind: 'ingest_disk_to_provider'; markdown: string }
  | { kind: 'conflict'; baseMarkdown: string; diskMarkdown: string; providerMarkdown: string };

export interface MarkdownReconciliationInput {
  lastProjectedMarkdown: string;
  diskMarkdown: string;
  providerMarkdown: string;
}

export function normalizeCollabMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/gu, '\n');
}

export function decideMarkdownReconciliation(input: MarkdownReconciliationInput): MarkdownReconciliationDecision {
  const baseMarkdown = normalizeCollabMarkdown(input.lastProjectedMarkdown);
  const diskMarkdown = normalizeCollabMarkdown(input.diskMarkdown);
  const providerMarkdown = normalizeCollabMarkdown(input.providerMarkdown);

  if (diskMarkdown === providerMarkdown) {
    return diskMarkdown === baseMarkdown
      ? { kind: 'noop', markdown: diskMarkdown }
      : { kind: 'accept_converged', markdown: diskMarkdown };
  }

  const diskChanged = diskMarkdown !== baseMarkdown;
  const providerChanged = providerMarkdown !== baseMarkdown;

  if (!diskChanged && providerChanged) {
    return { kind: 'project_provider_to_disk', markdown: providerMarkdown };
  }

  if (diskChanged && !providerChanged) {
    return { kind: 'ingest_disk_to_provider', markdown: diskMarkdown };
  }

  return {
    kind: 'conflict',
    baseMarkdown,
    diskMarkdown,
    providerMarkdown,
  };
}
