import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type StoredLocalVersionOperation =
  | 'open'
  | 'manual_save'
  | 'pre_restore'
  | 'rollback'
  | 'conflict_recovery';

export interface StoredLocalDocument {
  schemaVersion: 1;
  localDocId: string;
  absolutePath: string;
  displayName: string;
  roomName: string;
  lastDiskHash: string;
  currentHash: string;
  currentYjsStateBase64: string;
  updatedAt: string;
}

export interface StoredLocalVersion {
  schemaVersion: 1;
  versionId: string;
  localDocId: string;
  versionNumber: number;
  operation: StoredLocalVersionOperation;
  markdownSnapshot: string;
  yjsStateBase64: string;
  hash: string;
  createdAt: string;
}

export interface LocalMetadataStore {
  loadDocument(absolutePath: string): Promise<StoredLocalDocument | null>;
  saveDocument(document: StoredLocalDocument): Promise<void>;
  listVersions(localDocId: string): Promise<StoredLocalVersion[]>;
  appendVersion(version: StoredLocalVersion): Promise<void>;
  getLastLoadError?(): string | null;
}

interface LocalMetadataFile {
  schemaVersion: 1;
  documents: Record<string, StoredLocalDocument>;
  versions: StoredLocalVersion[];
}

const lockRetryIntervalMs = 10;
const lockTimeoutMs = 10_000;

function emptyMetadataFile(): LocalMetadataFile {
  return {
    schemaVersion: 1,
    documents: {},
    versions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadataFile(value: unknown): LocalMetadataFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.documents) || !Array.isArray(value.versions)) {
    throw new Error('invalid_local_metadata');
  }

  return {
    schemaVersion: 1,
    documents: value.documents as Record<string, StoredLocalDocument>,
    versions: value.versions as StoredLocalVersion[],
  };
}

export function defaultMarklabAppSupportDirectory(): string {
  const override = process.env.MARKLAB_APP_SUPPORT_DIR;
  if (override?.trim()) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MarkLab');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'MarkLab');
}

export function defaultLocalMetadataPath(): string {
  return process.env.MARKLAB_LOCAL_METADATA_PATH ?? join(defaultMarklabAppSupportDirectory(), 'marklab-local.json');
}

export function createJsonLocalMetadataStore(metadataPath = defaultLocalMetadataPath()): LocalMetadataStore {
  let writeQueue: Promise<void> = Promise.resolve();
  let lastLoadError: string | null = null;
  const lockPath = `${metadataPath}.lock`;

  async function readMetadataFile(): Promise<LocalMetadataFile> {
    try {
      const raw = await readFile(metadataPath, 'utf8');
      const parsed = parseMetadataFile(JSON.parse(raw));
      lastLoadError = null;
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        lastLoadError = null;
        return emptyMetadataFile();
      }

      lastLoadError = 'corrupt_metadata';
      return emptyMetadataFile();
    }
  }

  async function writeMetadataFile(metadata: LocalMetadataFile): Promise<void> {
    await mkdir(dirname(metadataPath), { recursive: true });
    const temporaryPath = join(
      dirname(metadataPath),
      `.${basename(metadataPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, metadataPath);
  }

  async function waitForLockRetry(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, lockRetryIntervalMs));
  }

  async function withMetadataWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(metadataPath), { recursive: true });
    const startedAt = Date.now();

    while (true) {
      let lockHandle: FileHandle | undefined;
      try {
        lockHandle = await open(lockPath, 'wx', 0o600);
        try {
          await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
          return await operation();
        } finally {
          await lockHandle.close();
          lockHandle = undefined;
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        if (lockHandle) {
          await lockHandle.close().catch(() => undefined);
        }
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
          if (Date.now() - startedAt >= lockTimeoutMs) {
            throw new Error('local_metadata_lock_timeout');
          }
          await waitForLockRetry();
          continue;
        }

        throw error;
      }
    }
  }

  async function updateMetadataFile(mutator: (metadata: LocalMetadataFile) => void): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      await withMetadataWriteLock(async () => {
        const metadata = await readMetadataFile();
        mutator(metadata);
        await writeMetadataFile(metadata);
        lastLoadError = null;
      });
    });
    return writeQueue;
  }

  return {
    async loadDocument(absolutePath) {
      const metadata = await readMetadataFile();
      return Object.values(metadata.documents).find((document) => document.absolutePath === absolutePath) ?? null;
    },
    async saveDocument(document) {
      await updateMetadataFile((metadata) => {
        metadata.documents[document.localDocId] = document;
      });
    },
    async listVersions(localDocId) {
      const metadata = await readMetadataFile();
      return metadata.versions
        .filter((version) => version.localDocId === localDocId)
        .sort((left, right) => left.versionNumber - right.versionNumber);
    },
    async appendVersion(version) {
      await updateMetadataFile((metadata) => {
        const withoutDuplicate = metadata.versions.filter((candidate) => candidate.versionId !== version.versionId);
        withoutDuplicate.push(version);
        metadata.versions = withoutDuplicate.sort((left, right) => {
          if (left.localDocId !== right.localDocId) return left.localDocId.localeCompare(right.localDocId);
          return left.versionNumber - right.versionNumber;
        });
      });
    },
    getLastLoadError() {
      return lastLoadError;
    },
  };
}
