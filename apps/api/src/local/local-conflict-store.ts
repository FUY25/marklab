import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type ReconnectConflictStatus = 'open' | 'resolved' | 'cancelled';

export interface ReconnectConflict {
  conflictId: string;
  relayRoomId: string;
  localDocId: string;
  localPath: string;
  baseMarkdown: string | null;
  baseYjsStateBase64: string | null;
  baseHash: string | null;
  lastProjectedMarkdown: string;
  lastProjectedHash: string;
  localMarkdown: string;
  localYjsStateBase64: string;
  localHash: string;
  sharedMarkdown: string;
  sharedYjsStateBase64: string;
  sharedHash: string;
  expectedSharedRevision: number;
  expectedSharedHash: string;
  sharedStateFingerprint: string;
  sharedRevision: number;
  createdAt: string;
  updatedAt: string;
  status: ReconnectConflictStatus;
}

export interface LocalConflictStore {
  loadConflict(conflictId: string): Promise<ReconnectConflict | null>;
  loadCurrentConflict(localPath: string): Promise<ReconnectConflict | null>;
  saveConflict(conflict: ReconnectConflict): Promise<void>;
}

interface LocalConflictFile {
  schemaVersion: 1;
  conflicts: Record<string, ReconnectConflict>;
}

function emptyConflictFile(): LocalConflictFile {
  return {
    schemaVersion: 1,
    conflicts: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConflictFile(value: unknown): LocalConflictFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.conflicts)) {
    throw new Error('invalid_local_conflict_store');
  }

  return {
    schemaVersion: 1,
    conflicts: Object.fromEntries(
      Object.entries(value.conflicts).map(([conflictId, conflict]) => {
        const reconnectConflict = conflict as ReconnectConflict & Partial<Pick<ReconnectConflict, 'lastProjectedMarkdown' | 'lastProjectedHash'>>;
        return [
          conflictId,
          {
            ...reconnectConflict,
            lastProjectedMarkdown: reconnectConflict.lastProjectedMarkdown ?? reconnectConflict.baseMarkdown ?? '',
            lastProjectedHash: reconnectConflict.lastProjectedHash ?? reconnectConflict.baseHash ?? '',
          },
        ];
      }),
    ),
  };
}

export function defaultMarklabAppSupportDirectory(): string {
  const override = process.env.MARKLAB_APP_SUPPORT_DIR;
  if (override?.trim()) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MarkLab');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'MarkLab');
}

export function defaultLocalConflictPath(): string {
  return process.env.MARKLAB_LOCAL_CONFLICT_PATH ?? join(defaultMarklabAppSupportDirectory(), 'marklab-conflicts.json');
}

export function createJsonLocalConflictStore(conflictPath = defaultLocalConflictPath()): LocalConflictStore {
  async function readConflictFile(): Promise<LocalConflictFile> {
    try {
      return parseConflictFile(JSON.parse(await readFile(conflictPath, 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyConflictFile();
      return emptyConflictFile();
    }
  }

  async function writeConflictFile(conflicts: LocalConflictFile): Promise<void> {
    await mkdir(dirname(conflictPath), { recursive: true });
    const temporaryPath = join(
      dirname(conflictPath),
      `.${basename(conflictPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(conflicts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, conflictPath);
  }

  return {
    async loadConflict(conflictId) {
      const file = await readConflictFile();
      return file.conflicts[conflictId] ?? null;
    },
    async loadCurrentConflict(localPath) {
      const file = await readConflictFile();
      return (
        Object.values(file.conflicts)
          .filter((conflict) => conflict.localPath === localPath && conflict.status === 'open')
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
      );
    },
    async saveConflict(conflict) {
      const file = await readConflictFile();
      file.conflicts[conflict.conflictId] = conflict;
      await writeConflictFile(file);
    },
  };
}
