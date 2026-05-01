import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { sha256Hex } from '@marklab/shared/src/hash';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import {
  createJsonLocalMetadataStore,
  type LocalMetadataStore,
  type StoredLocalVersion,
  type StoredLocalVersionOperation,
} from './local-metadata-store';

export type LocalVersionOperation = StoredLocalVersionOperation;

export interface LocalFileDocumentSummary {
  localDocId: string;
  displayName: string;
  absolutePath: string;
  roomName: string;
  hash: string;
  conflict: string | null;
  historyLoadError: string | null;
}

export interface LocalVersionSummary {
  versionId: string;
  versionNumber: number;
  operation: LocalVersionOperation;
  hash: string;
  createdAt: string;
}

export interface LocalVersionDetail extends LocalVersionSummary {
  markdown: string;
}

export interface LocalManualSaveResult {
  created: boolean;
  versionId: string;
  versionNumber: number;
  hash: string;
}

export interface LocalRestoreResult {
  versionId: string;
  versionNumber: number;
  hash: string;
  yjsState: Uint8Array;
}

export interface LocalLoadedRoomState {
  yjsState: Uint8Array;
  stateFingerprint: string;
}

export interface LocalStoreRoomStateResult {
  stored: boolean;
  stateFingerprint?: string;
}

export interface LocalRoomStore {
  canHandleRoom(roomName: string): boolean;
  loadRoomState(roomName: string): Promise<LocalLoadedRoomState | null>;
  storeRoomState(
    roomName: string,
    yjsState: Uint8Array,
    expectedStateFingerprint: string | null,
  ): Promise<LocalStoreRoomStateResult>;
}

export interface LocalWatcherCallbacks {
  flushRoom(roomName: string): Promise<void>;
  applyRoomState(roomName: string, yjsState: Uint8Array): Promise<void>;
}

interface LocalVersionRecord {
  versionId: string;
  versionNumber: number;
  operation: LocalVersionOperation;
  markdown: string;
  yjsState: Uint8Array;
  hash: string;
  createdAt: string;
}

export interface LocalFileService extends LocalRoomStore {
  readonly roomName: string;
  getSummary(): LocalFileDocumentSummary;
  listVersions(): LocalVersionSummary[];
  getVersion(versionId: string): LocalVersionDetail;
  createManualVersion(): Promise<LocalManualSaveResult>;
  restoreVersion(versionId: string): Promise<LocalRestoreResult>;
  startWatcher(callbacks: LocalWatcherCallbacks): void;
  stopWatcher(): void;
}

export interface LocalFileServiceOptions {
  metadataStore?: LocalMetadataStore;
  metadataPath?: string;
}

const runtime = createHeadlessMilkdownRuntime();

function localDocIdForPath(absolutePath: string): string {
  return sha256Hex(absolutePath).replace(/^sha256:/u, '').slice(0, 16);
}

function rawMarkdownHash(markdown: string): string {
  return sha256Hex(markdown);
}

async function readMarkdownFile(absolutePath: string): Promise<string> {
  return readFile(absolutePath, 'utf8');
}

async function writeMarkdownFileAtomically(absolutePath: string, markdown: string): Promise<void> {
  const directory = dirname(absolutePath);
  const temporaryPath = join(directory, `.${basename(absolutePath)}.marklab-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporaryPath, markdown, 'utf8');
  await rename(temporaryPath, absolutePath);
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function toVersionSummary(version: LocalVersionRecord): LocalVersionSummary {
  return {
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    operation: version.operation,
    hash: version.hash,
    createdAt: version.createdAt,
  };
}

export async function createLocalFileService(inputPath: string): Promise<LocalFileService> {
  return createLocalFileServiceWithOptions(inputPath);
}

export async function createLocalFileServiceWithOptions(
  inputPath: string,
  options: LocalFileServiceOptions = {},
): Promise<LocalFileService> {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, '', 'utf8');
  }

  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error('local_file_not_file');

  const localDocId = localDocIdForPath(absolutePath);
  const roomName = `local:file:${localDocId}`;
  const displayName = basename(absolutePath);
  const initialDiskMarkdown = await readMarkdownFile(absolutePath);
  const initialized = await runtime.initializeFromMarkdown(initialDiskMarkdown);
  if (initialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
  const metadataStore = options.metadataStore ?? createJsonLocalMetadataStore(options.metadataPath);

  let currentYjsState = initialized.yjsState;
  let currentMarkdown = initialized.markdown;
  let currentHash = initialized.hash;
  let currentStateFingerprint = encodeYjsStateFingerprint(initialized.yjsState);
  let lastDiskHash = rawMarkdownHash(initialDiskMarkdown);
  let conflict: string | null = null;
  let historyLoadError: string | null = null;
  let lastConflictRecoveryHash: string | null = null;
  let watcher: FSWatcher | null = null;
  let watcherTimer: NodeJS.Timeout | null = null;
  let isHandlingWatcherEvent = false;
  let shouldHandleWatcherAgain = false;

  let versions: LocalVersionRecord[] = [];
  try {
    await metadataStore.loadDocument(absolutePath);
    const storedVersions = await metadataStore.listVersions(localDocId);
    versions = storedVersions.map((version) => ({
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      operation: version.operation,
      markdown: version.markdownSnapshot,
      yjsState: decodeBase64(version.yjsStateBase64),
      hash: version.hash,
      createdAt: version.createdAt,
    }));
    historyLoadError = metadataStore.getLastLoadError?.() ?? null;
  } catch {
    versions = [];
    historyLoadError = 'corrupt_metadata';
  }

  function assertRoom(room: string): void {
    if (room !== roomName) throw new Error('local_room_not_found');
  }

  function nextVersionNumber(): number {
    return Math.max(0, ...versions.map((version) => version.versionNumber)) + 1;
  }

  async function persistCurrentDocument(): Promise<void> {
    await metadataStore.saveDocument({
      schemaVersion: 1,
      localDocId,
      absolutePath,
      displayName,
      roomName,
      lastDiskHash,
      currentHash,
      currentYjsStateBase64: encodeBase64(currentYjsState),
      updatedAt: new Date().toISOString(),
    });
  }

  async function createVersion(
    operation: LocalVersionOperation,
    markdown: string,
    yjsState: Uint8Array,
    hash: string,
  ): Promise<LocalVersionRecord> {
    const versionNumber = nextVersionNumber();
    const version: LocalVersionRecord = {
      versionId: `${localDocId}-v${versionNumber}`,
      versionNumber,
      operation,
      markdown,
      yjsState: new Uint8Array(yjsState),
      hash,
      createdAt: new Date().toISOString(),
    };
    versions.push(version);
    await metadataStore.appendVersion({
      schemaVersion: 1,
      versionId: version.versionId,
      localDocId,
      versionNumber,
      operation,
      markdownSnapshot: markdown,
      yjsStateBase64: encodeBase64(yjsState),
      hash,
      createdAt: version.createdAt,
    } satisfies StoredLocalVersion);
    return version;
  }

  async function ensureInitialVersion(): Promise<void> {
    if (versions.length > 0) return;
    await createVersion('open', currentMarkdown, currentYjsState, currentHash);
  }

  async function createConflictRecoverySnapshot(): Promise<void> {
    if (lastConflictRecoveryHash === currentHash) return;
    const latest = versions.at(-1);
    if (latest?.operation === 'conflict_recovery' && latest.hash === currentHash) {
      lastConflictRecoveryHash = currentHash;
      return;
    }

    await createVersion('conflict_recovery', currentMarkdown, currentYjsState, currentHash);
    lastConflictRecoveryHash = currentHash;
  }

  async function applySerializedRoomState(yjsState: Uint8Array): Promise<void> {
    const serialized = await runtime.serializeYjsState(yjsState);
    if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

    if (serialized.hash === currentHash) {
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentStateFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
      await persistCurrentDocument();
      return;
    }

    const diskMarkdown = await readMarkdownFile(absolutePath);
    const diskHash = rawMarkdownHash(diskMarkdown);
    if (diskHash !== lastDiskHash && diskHash !== rawMarkdownHash(serialized.markdown)) {
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = serialized.hash;
      currentStateFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return;
    }

    await writeMarkdownFileAtomically(absolutePath, serialized.markdown);
    lastDiskHash = rawMarkdownHash(serialized.markdown);
    currentYjsState = serialized.yjsState;
    currentMarkdown = serialized.markdown;
    currentHash = serialized.hash;
    currentStateFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
    conflict = null;
    await persistCurrentDocument();
  }

  async function applyExternalDiskMarkdown(markdown: string): Promise<Uint8Array | null> {
    const diskHash = rawMarkdownHash(markdown);
    if (diskHash === lastDiskHash) return null;

    const applied = await runtime.applyChangedRanges({
      branchId: localDocId,
      yjsState: currentYjsState,
      seedMarkdown: currentMarkdown,
      targetCanonicalMarkdown: markdown,
    });
    if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

    currentYjsState = applied.yjsState;
    currentMarkdown = applied.serializedMarkdown;
    currentHash = rawMarkdownHash(applied.serializedMarkdown);
    currentStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
    lastDiskHash = diskHash;
    conflict = null;
    await persistCurrentDocument();
    return applied.yjsState;
  }

  async function handleWatcherEvent(callbacks: LocalWatcherCallbacks): Promise<void> {
    if (isHandlingWatcherEvent) {
      shouldHandleWatcherAgain = true;
      return;
    }

    isHandlingWatcherEvent = true;
    try {
      do {
        shouldHandleWatcherAgain = false;
        const markdown = await readMarkdownFile(absolutePath);
        if (rawMarkdownHash(markdown) === lastDiskHash) continue;
        await callbacks.flushRoom(roomName);
        if (conflict) return;
        const latestMarkdown = await readMarkdownFile(absolutePath);
        const yjsState = await applyExternalDiskMarkdown(latestMarkdown);
        if (yjsState) await callbacks.applyRoomState(roomName, yjsState);
      } while (shouldHandleWatcherAgain);
    } finally {
      isHandlingWatcherEvent = false;
    }
  }

  await ensureInitialVersion();
  await persistCurrentDocument();

  return {
    roomName,
    canHandleRoom(candidateRoomName) {
      return candidateRoomName === roomName;
    },
    async loadRoomState(candidateRoomName) {
      assertRoom(candidateRoomName);
      return {
        yjsState: new Uint8Array(currentYjsState),
        stateFingerprint: currentStateFingerprint,
      };
    },
    async storeRoomState(candidateRoomName, yjsState) {
      assertRoom(candidateRoomName);
      await applySerializedRoomState(yjsState);
      return {
        stored: true,
        stateFingerprint: currentStateFingerprint,
      };
    },
    getSummary() {
      return {
        localDocId,
        displayName,
        absolutePath,
        roomName,
        hash: currentHash,
        conflict,
        historyLoadError,
      };
    },
    listVersions() {
      return versions.map(toVersionSummary).reverse();
    },
    getVersion(versionId) {
      const version = versions.find((candidate) => candidate.versionId === versionId);
      if (!version) throw new Error('local_version_not_found');
      return {
        ...toVersionSummary(version),
        markdown: version.markdown,
      };
    },
    async createManualVersion() {
      const latest = versions.at(-1);
      if (latest?.hash === currentHash) {
        return {
          created: false,
          versionId: latest.versionId,
          versionNumber: latest.versionNumber,
          hash: latest.hash,
        };
      }

      const version = await createVersion('manual_save', currentMarkdown, currentYjsState, currentHash);
      await persistCurrentDocument();
      return {
        created: true,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        hash: version.hash,
      };
    },
    async restoreVersion(versionId) {
      const source = versions.find((candidate) => candidate.versionId === versionId);
      if (!source) throw new Error('local_version_not_found');
      const diskMarkdown = await readMarkdownFile(absolutePath);
      const diskHash = rawMarkdownHash(diskMarkdown);
      if (currentHash !== source.hash) {
        await createVersion('pre_restore', currentMarkdown, currentYjsState, currentHash);
      }
      if (diskHash !== source.hash && diskHash !== currentHash) {
        const diskState = await runtime.initializeFromMarkdown(diskMarkdown);
        if (diskState.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
        await createVersion('pre_restore', diskMarkdown, diskState.yjsState, diskHash);
      }

      const applied = await runtime.applyChangedRanges({
        branchId: localDocId,
        yjsState: currentYjsState,
        seedMarkdown: currentMarkdown,
        targetCanonicalMarkdown: source.markdown,
      });
      if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

      await writeMarkdownFileAtomically(absolutePath, applied.serializedMarkdown);
      currentYjsState = applied.yjsState;
      currentMarkdown = applied.serializedMarkdown;
      currentHash = rawMarkdownHash(applied.serializedMarkdown);
      currentStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
      lastDiskHash = rawMarkdownHash(applied.serializedMarkdown);
      conflict = null;
      lastConflictRecoveryHash = null;

      const version = await createVersion('rollback', currentMarkdown, currentYjsState, currentHash);
      await persistCurrentDocument();
      return {
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        hash: version.hash,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    startWatcher(callbacks) {
      if (watcher) return;
      watcher = watch(dirname(absolutePath), (_eventType, changedFilename) => {
        if (changedFilename && changedFilename.toString() !== basename(absolutePath)) return;
        if (watcherTimer) clearTimeout(watcherTimer);
        watcherTimer = setTimeout(() => {
          watcherTimer = null;
          void handleWatcherEvent(callbacks);
        }, 250);
      });
    },
    stopWatcher() {
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
