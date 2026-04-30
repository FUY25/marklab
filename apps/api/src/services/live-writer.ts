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
    }
  | {
      kind: 'rollback';
      sourceVersionId: string;
    };

export interface LiveMarkdownTransaction {
  branchId: string;
  targetCanonicalMarkdown: string;
  operation: LiveMarkdownOperation;
}

export interface AppliedLiveMarkdownTransaction {
  serializedMarkdown: string;
  yjsState: Uint8Array;
  sourceStateFingerprint?: string;
  previousSerializedMarkdown?: string;
  previousHash?: string;
  changedRangeCount: number;
  changedCharacterCount: number;
  documentCharacterCount: number;
  fullDocumentReplacement: boolean;
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
