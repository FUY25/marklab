import type { DbExecutor } from '../db/client';

export interface InitializedBranchEditorState {
  yjsState: Uint8Array;
  markdown: string;
  hash: string;
}

function milkdownTransformerNotConfigured(): Error {
  return new Error('milkdown_transformer_not_configured');
}

export async function initializeBranchEditorState(_markdown: string): Promise<InitializedBranchEditorState> {
  throw milkdownTransformerNotConfigured();
}

export async function flushBranchMarkdownMirror(
  _db: DbExecutor,
  _docId: string,
  _branchId: string,
): Promise<void> {
  throw milkdownTransformerNotConfigured();
}
