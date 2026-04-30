export function buildBranchRoomName(docId: string, branchId: string): string {
  if (!docId) throw new Error('missing_doc_id');
  if (!branchId) throw new Error('missing_branch_id');
  return `doc:${docId}:branch:${branchId}`;
}
