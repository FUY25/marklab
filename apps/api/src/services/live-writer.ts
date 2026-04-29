export type LiveMarkdownOperation =
  | {
      kind: 'write';
      baseVersionId: string;
      baseHash: string;
    }
  | {
      kind: 'edit';
      baseVersionId: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    }
  | {
      kind: 'multi_edit';
      baseVersionId: string;
      edits: Array<{
        oldString: string;
        newString: string;
        replaceAll: boolean;
      }>;
    };

export interface LiveMarkdownTransaction {
  branchId: string;
  targetCanonicalMarkdown: string;
  operation: LiveMarkdownOperation;
}

export interface AppliedLiveMarkdownTransaction {
  serializedMarkdown: string;
  changedRangeCount: number;
  appliedTransactionCount: number;
}

export interface LiveMarkdownWriter {
  applyMarkdownTransaction(transaction: LiveMarkdownTransaction): Promise<AppliedLiveMarkdownTransaction>;
}

export function createUnavailableLiveMarkdownWriter(): LiveMarkdownWriter {
  return {
    async applyMarkdownTransaction() {
      throw new Error('live_writer_not_configured');
    },
  };
}
