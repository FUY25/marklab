export const AUTOSAVE_VERSION_INTERVAL_MS = 10 * 60 * 1000;
export const AUTOSAVE_FINAL_QUIET_MS = 2 * 60 * 1000;

export function shouldCreateVersionForCurrentHash(currentHash: string, headHash: string): boolean {
  return currentHash !== headHash;
}

export interface ShouldCreateAutosaveInput {
  currentHash: string;
  headHash: string;
  lastAutosaveAt: Date | null;
  activeStartedAt?: Date | null;
  pendingHashFirstSeenAt?: Date | null;
  now: Date;
}

export function shouldCreateAutosaveVersion(input: ShouldCreateAutosaveInput): boolean {
  if (!shouldCreateVersionForCurrentHash(input.currentHash, input.headHash)) return false;
  if (
    input.pendingHashFirstSeenAt
    && input.now.getTime() - input.pendingHashFirstSeenAt.getTime() >= AUTOSAVE_FINAL_QUIET_MS
  ) {
    return true;
  }
  const activeCheckpointAnchor = input.lastAutosaveAt ?? input.activeStartedAt;
  if (!activeCheckpointAnchor) return false;
  return input.now.getTime() - activeCheckpointAnchor.getTime() >= AUTOSAVE_VERSION_INTERVAL_MS;
}
