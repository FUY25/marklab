export type LiveMarkdownOperation =
  | {
      kind: 'write';
      baseVersionId: string;
      baseHash: string;
    }
  | {
      kind: 'edit';
      observedVersionId?: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    };

export interface LiveMarkdownTransaction {
  branchId: string;
  targetCanonicalMarkdown: string;
  operation: LiveMarkdownOperation;
}

export interface AppliedLiveMarkdownTransaction {
  serializedMarkdown: string;
  yjsState: Uint8Array;
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
