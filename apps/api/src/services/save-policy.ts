export const AUTOSAVE_VERSION_INTERVAL_MS = 10 * 60 * 1000;

export function shouldCreateVersionForCurrentHash(currentHash: string, headHash: string): boolean {
  return currentHash !== headHash;
}

export interface ShouldCreateAutosaveInput {
  currentHash: string;
  headHash: string;
  lastAutosaveAt: Date | null;
  now: Date;
}

export function shouldCreateAutosaveVersion(input: ShouldCreateAutosaveInput): boolean {
  if (!shouldCreateVersionForCurrentHash(input.currentHash, input.headHash)) return false;
  if (!input.lastAutosaveAt) return true;
  return input.now.getTime() - input.lastAutosaveAt.getTime() >= AUTOSAVE_VERSION_INTERVAL_MS;
}
