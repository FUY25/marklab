export interface LiveMarkdownWriter {
  replaceBranchMarkdown(branchId: string, canonicalMarkdown: string): Promise<string>;
}

export function createUnavailableLiveMarkdownWriter(): LiveMarkdownWriter {
  return {
    async replaceBranchMarkdown() {
      throw new Error('live_writer_not_configured');
    },
  };
}
