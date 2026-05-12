import { randomUUID } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { link, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { sha256Hex } from '@marklab/shared/src/hash';
import { decideMarkdownReconciliation, normalizeCollabMarkdown } from '@marklab/shared/src/markdown-reconciliation';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import {
  createJsonLocalMetadataStore,
  type LocalMetadataStore,
  type StoredLocalDocument,
  type StoredLocalRelayHostState,
  type StoredLocalRelayJoinState,
  type StoredLocalVersion,
  type StoredLocalVersionOperation,
} from './local-metadata-store';
import {
  createJsonLocalConflictStore,
  type LocalConflictStore,
  type ReconnectConflict,
} from './local-conflict-store';

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
  source?: 'agent' | 'user' | 'system';
  message?: string | null;
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
  source?: 'agent' | 'user' | 'system';
  message?: string | null;
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
  yjsState?: Uint8Array;
  prepare?: () => Promise<void>;
  markApplied?: () => Promise<void>;
  commit?: () => Promise<boolean | void>;
  abort?: () => Promise<void>;
}

interface PendingProviderApply {
  yjsState: Uint8Array;
  stateFingerprint: string;
  prepare(): Promise<void>;
  markApplied(): Promise<void>;
  commit(): Promise<boolean | void>;
  abort(): Promise<void>;
}

export interface OpenReconnectConflictInput {
  relayRoomId: string;
  sharedYjsStateBase64: string;
  sharedHash: string | null;
  sharedRevision: number;
  baseMarkdown?: string | null;
  baseYjsStateBase64?: string | null;
  baseHash?: string | null;
}

export interface LocalConflictResolutionResult {
  conflictId: string;
  status: 'resolved';
  hash: string;
  sharedRevision: number | null;
  yjsState: Uint8Array;
}

export interface PreparedLocalConflictResolution {
  conflictId: string;
  hash: string;
  yjsState: Uint8Array;
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
  source: 'agent' | 'user' | 'system';
  message: string | null;
  createdAt: string;
}

export interface LocalFileService extends LocalRoomStore {
  readonly roomName: string;
  getSummary(): LocalFileDocumentSummary;
  getRelayHostState(): StoredLocalRelayHostState | null;
  saveRelayHostState(state: StoredLocalRelayHostState): Promise<void>;
  clearRelayHostState(): Promise<void>;
  getRelayJoinState(): StoredLocalRelayJoinState | null;
  saveRelayJoinState(state: StoredLocalRelayJoinState): Promise<void>;
  isBackingFileAvailable?(): boolean;
  pauseForMissingBackingFile?(kind: 'host' | 'mirror'): Promise<void>;
  pauseForRelayConflict(message: string): Promise<void>;
  getCurrentConflict(): ReconnectConflict | null;
  getConflict(conflictId: string): Promise<ReconnectConflict | null>;
  openReconnectConflict(input: OpenReconnectConflictInput): Promise<ReconnectConflict>;
  prepareUseSharedConflict(conflictId: string): Promise<PreparedLocalConflictResolution>;
  prepareUseLocalConflict(
    conflictId: string,
    expectedSharedRevision?: number,
    expectedSharedHash?: string,
  ): Promise<PreparedLocalConflictResolution>;
  prepareResolvedConflict(
    conflictId: string,
    markdown: string,
    expectedSharedRevision: number,
    expectedSharedHash: string,
  ): Promise<PreparedLocalConflictResolution>;
  completeConflictResolution(conflictId: string, sharedRevision: number | null): Promise<LocalConflictResolutionResult>;
  useSharedConflict(conflictId: string): Promise<LocalConflictResolutionResult>;
  useLocalConflict(
    conflictId: string,
    expectedSharedRevision?: number,
    expectedSharedHash?: string,
  ): Promise<LocalConflictResolutionResult>;
  resolveConflict(
    conflictId: string,
    markdown: string,
    expectedSharedRevision: number,
    expectedSharedHash: string,
  ): Promise<LocalConflictResolutionResult>;
  listVersions(): LocalVersionSummary[];
  getVersion(versionId: string): LocalVersionDetail;
  createManualVersion(input?: { source?: 'agent' | 'user' | 'system'; message?: string | null }): Promise<LocalManualSaveResult>;
  restoreVersion(versionId: string): Promise<LocalRestoreResult>;
  startWatcher(callbacks: LocalWatcherCallbacks): void;
  stopWatcher(): void;
}

export interface LocalFileServiceOptions {
  metadataStore?: LocalMetadataStore;
  conflictStore?: LocalConflictStore;
  metadataPath?: string;
  conflictPath?: string;
  beforeProjectionWrite?: () => Promise<void> | void;
  beforeProjectionOpen?: () => Promise<void> | void;
  beforeProjectionCommit?: () => Promise<void> | void;
  beforeProjectionRename?: () => Promise<void> | void;
  runtime?: LocalFileRuntime;
}

const runtime = createHeadlessMilkdownRuntime();
type LocalFileRuntime = Pick<typeof runtime, 'initializeFromMarkdown' | 'serializeYjsState' | 'applyChangedRanges'>;

function localDocIdForPath(absolutePath: string): string {
  return sha256Hex(absolutePath).replace(/^sha256:/u, '').slice(0, 16);
}

function rawMarkdownHash(markdown: string): string {
  return sha256Hex(markdown);
}

function collabMarkdownHash(markdown: string): string {
  return rawMarkdownHash(normalizeCollabMarkdown(markdown));
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

async function openFileStillMatchesPath(file: Awaited<ReturnType<typeof open>>, absolutePath: string): Promise<boolean> {
  try {
    const [openFileStat, pathStat] = await Promise.all([file.stat(), stat(absolutePath)]);
    return openFileStat.dev === pathStat.dev && openFileStat.ino === pathStat.ino;
  } catch {
    return false;
  }
}

async function writeMarkdownFileAtomicallyIfUnchanged(
  absolutePath: string,
  markdown: string,
  expectedHash: string,
  beforeOpen?: () => Promise<void> | void,
  beforeFinalCheck?: () => Promise<void> | void,
  beforeCommit?: () => Promise<void> | void,
  beforeRename?: () => Promise<void> | void,
): Promise<boolean> {
  const directory = dirname(absolutePath);
  const temporaryPath = join(directory, `.${basename(absolutePath)}.marklab-${process.pid}-${Date.now()}.tmp`);
  let file: FileHandle | undefined;

  try {
    await writeFile(temporaryPath, markdown, 'utf8');
    await beforeOpen?.();
    try {
      file = await open(absolutePath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }

    await beforeFinalCheck?.();
    if (!(await openFileStillMatchesPath(file, absolutePath))) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    const latestMarkdown = await readMarkdownFile(absolutePath);
    if (collabMarkdownHash(latestMarkdown) !== expectedHash) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    await beforeCommit?.();
    if (!(await openFileStillMatchesPath(file, absolutePath))) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    const latestMarkdownBeforeCommit = await readMarkdownFile(absolutePath);
    if (collabMarkdownHash(latestMarkdownBeforeCommit) !== expectedHash) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    if (!(await openFileStillMatchesPath(file, absolutePath))) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    await beforeRename?.();
    if (!(await openFileStillMatchesPath(file, absolutePath))) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    const latestMarkdownBeforeRename = await readMarkdownFile(absolutePath);
    if (collabMarkdownHash(latestMarkdownBeforeRename) !== expectedHash) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return false;
    }

    const backupPath = join(directory, `.${basename(absolutePath)}.marklab-backup-${process.pid}-${Date.now()}-${randomUUID()}.bak`);
    let backupNeedsCleanup = false;
    try {
      await link(absolutePath, backupPath);
      backupNeedsCleanup = true;

      const backedUpMarkdown = await readMarkdownFile(backupPath);
      if (collabMarkdownHash(backedUpMarkdown) !== expectedHash) {
        await rm(backupPath, { force: true });
        backupNeedsCleanup = false;
        return false;
      }

      if (!(await openFileStillMatchesPath(file, absolutePath))) {
        await rm(backupPath, { force: true });
        backupNeedsCleanup = false;
        return false;
      }

      const latestMarkdownBeforeReplace = await readMarkdownFile(absolutePath);
      if (collabMarkdownHash(latestMarkdownBeforeReplace) !== expectedHash) {
        await rm(backupPath, { force: true });
        backupNeedsCleanup = false;
        return false;
      }

      await rename(temporaryPath, absolutePath);
      await rm(backupPath, { force: true });
      backupNeedsCleanup = false;
    } catch (error) {
      if (backupNeedsCleanup) {
        await rm(backupPath, { force: true });
      }
      if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  } finally {
    await file?.close();
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  const committedMarkdown = await readMarkdownFile(absolutePath);
  return collabMarkdownHash(committedMarkdown) === collabMarkdownHash(markdown);
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
    source: version.source,
    message: version.message,
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
  const documentRuntime = options.runtime ?? runtime;
  const metadataStore = options.metadataStore ?? createJsonLocalMetadataStore(options.metadataPath);
  let storedDocumentForStartup: StoredLocalDocument | null = null;
  let startupMetadataLoadFailed = false;
  try {
    storedDocumentForStartup = await metadataStore.loadDocument(absolutePath);
  } catch {
    startupMetadataLoadFailed = true;
  }

  let backingFileMissingOnStartup = false;
  if (!existsSync(absolutePath)) {
    if (storedDocumentForStartup) {
      backingFileMissingOnStartup = true;
    } else {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '', 'utf8');
    }
  }

  const localDocId = localDocIdForPath(absolutePath);
  const roomName = `local:file:${localDocId}`;
  const displayName = basename(absolutePath);
  let initialDiskMarkdown: string;
  let initialized: { yjsState: Uint8Array; markdown: string; hash: string };
  if (backingFileMissingOnStartup) {
    const storedYjsState = decodeBase64(storedDocumentForStartup!.currentYjsStateBase64);
    initialized = await documentRuntime.serializeYjsState(storedYjsState);
    initialDiskMarkdown = initialized.markdown;
  } else {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error('local_file_not_file');
    initialDiskMarkdown = await readMarkdownFile(absolutePath);
    initialized = await documentRuntime.initializeFromMarkdown(initialDiskMarkdown);
  }
  if (initialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
  const conflictPath = options.conflictPath ?? (options.metadataPath ? join(dirname(options.metadataPath), 'marklab-conflicts.json') : undefined);
  const conflictStore = options.conflictStore ?? createJsonLocalConflictStore(conflictPath);

  let currentYjsState = initialized.yjsState;
  let currentMarkdown = initialized.markdown;
  let currentHash = initialized.hash;
  let currentStateFingerprint = encodeYjsStateFingerprint(initialized.yjsState);
  let lastDiskHash = collabMarkdownHash(initialDiskMarkdown);
  let lastProjectedMarkdown = normalizeCollabMarkdown(initialized.markdown);
  let lastProjectedHash = collabMarkdownHash(lastProjectedMarkdown);
  let lastProviderStateFingerprint = currentStateFingerprint;
  let conflict: string | null = null;
  let currentOpenConflict: ReconnectConflict | null = null;
  let historyLoadError: string | null = null;
  let lastConflictRecoveryHash: string | null = null;
  let relayHostState: StoredLocalRelayHostState | null = null;
  let relayJoinState: StoredLocalRelayJoinState | null = null;
  let pendingProviderApply: StoredLocalDocument['pendingProviderApply'] | null = null;
  let watcher: FSWatcher | null = null;
  let watcherTimer: NodeJS.Timeout | null = null;
  let isHandlingWatcherEvent = false;
  let shouldHandleWatcherAgain = false;
  let hasStoredDocument = false;

  let versions: LocalVersionRecord[] = [];
  try {
    if (startupMetadataLoadFailed) throw new Error('metadata_load_failed');
    const storedDocument = storedDocumentForStartup;
    if (storedDocument) {
      hasStoredDocument = true;
      lastDiskHash = storedDocument.lastDiskHash;
      const storedYjsState = decodeBase64(storedDocument.currentYjsStateBase64);
      const storedState = await documentRuntime.serializeYjsState(storedYjsState);
      if (storedState.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
      currentYjsState = storedState.yjsState;
      currentMarkdown = storedState.markdown;
      currentHash = storedState.hash;
      currentStateFingerprint = encodeYjsStateFingerprint(storedState.yjsState);
      lastProviderStateFingerprint = currentStateFingerprint;
      if (storedDocument.lastProjectedMarkdown !== undefined) {
        lastProjectedMarkdown = normalizeCollabMarkdown(storedDocument.lastProjectedMarkdown);
        lastProjectedHash = storedDocument.lastProjectedHash ?? collabMarkdownHash(lastProjectedMarkdown);
        lastDiskHash = lastProjectedHash;
        lastProviderStateFingerprint = storedDocument.lastProviderStateFingerprint ?? currentStateFingerprint;
        pendingProviderApply = storedDocument.pendingProviderApply ?? null;
      } else {
        lastProjectedMarkdown = normalizeCollabMarkdown(currentMarkdown);
        lastProjectedHash = collabMarkdownHash(lastProjectedMarkdown);
        lastProviderStateFingerprint = currentStateFingerprint;
      }
    }
    relayHostState = await metadataStore.loadRelayHost(absolutePath);
    relayJoinState = await metadataStore.loadRelayJoin(absolutePath);
    const storedVersions = await metadataStore.listVersions(localDocId);
    versions = storedVersions.map((version) => ({
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      operation: version.operation,
      markdown: version.markdownSnapshot,
      yjsState: decodeBase64(version.yjsStateBase64),
      hash: version.hash,
      source: version.source ?? 'user',
      message: version.message ?? null,
      createdAt: version.createdAt,
    }));
    currentOpenConflict = await conflictStore.loadCurrentConflict(absolutePath);
    if (currentOpenConflict) conflict = 'Relay reconnect conflict. Review needed before syncing resumes.';
    historyLoadError = metadataStore.getLastLoadError?.() ?? null;
  } catch {
    versions = [];
    historyLoadError = 'corrupt_metadata';
  }

  function assertRoom(room: string): void {
    if (room !== roomName) throw new Error('local_room_not_found');
  }

  function isRelaySyncPaused(): boolean {
    return Boolean(currentOpenConflict) || Boolean(conflict);
  }

  function nextVersionNumber(): number {
    return Math.max(0, ...versions.map((version) => version.versionNumber)) + 1;
  }

  async function persistDocumentSnapshot(input: {
    lastDiskHash: string;
    currentHash: string;
    currentYjsState: Uint8Array;
    lastProjectedMarkdown: string;
    lastProjectedHash: string;
    lastProviderStateFingerprint: string;
    pendingProviderApply: StoredLocalDocument['pendingProviderApply'] | null;
  }): Promise<void> {
    await metadataStore.saveDocument({
      schemaVersion: 1,
      localDocId,
      absolutePath,
      displayName,
      roomName,
      lastDiskHash: input.lastDiskHash,
      currentHash: input.currentHash,
      currentYjsStateBase64: encodeBase64(input.currentYjsState),
      lastProjectedMarkdown: input.lastProjectedMarkdown,
      lastProjectedHash: input.lastProjectedHash,
      lastProviderStateFingerprint: input.lastProviderStateFingerprint,
      ...(input.pendingProviderApply ? { pendingProviderApply: input.pendingProviderApply } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async function persistCurrentDocument(): Promise<void> {
    await persistDocumentSnapshot({
      lastDiskHash,
      currentHash,
      currentYjsState,
      lastProjectedMarkdown,
      lastProjectedHash,
      lastProviderStateFingerprint,
      pendingProviderApply,
    });
  }

  async function persistProjectedDocumentState(input: {
    yjsState: Uint8Array;
    markdown: string;
    hash: string;
    projectedMarkdown: string;
    stateFingerprint: string;
  }): Promise<void> {
    const projectedMarkdown = normalizeCollabMarkdown(input.projectedMarkdown);
    const projectedHash = collabMarkdownHash(projectedMarkdown);
    await persistDocumentSnapshot({
      lastDiskHash: projectedHash,
      currentHash: input.hash,
      currentYjsState: input.yjsState,
      lastProjectedMarkdown: projectedMarkdown,
      lastProjectedHash: projectedHash,
      lastProviderStateFingerprint: input.stateFingerprint,
      pendingProviderApply: null,
    });
  }

  function markProjectedBaseline(markdown: string, stateFingerprint = currentStateFingerprint): void {
    lastProjectedMarkdown = normalizeCollabMarkdown(markdown);
    lastProjectedHash = collabMarkdownHash(lastProjectedMarkdown);
    lastProviderStateFingerprint = stateFingerprint;
    lastDiskHash = lastProjectedHash;
    pendingProviderApply = null;
  }

  function createPendingProviderApply(
    markdown: string,
    yjsState: Uint8Array,
    stateFingerprint: string,
  ): PendingProviderApply {
    const appliedYjsState = new Uint8Array(yjsState);
    return {
      yjsState: appliedYjsState,
      stateFingerprint,
      async prepare() {
        const nextPendingProviderApply = {
          markdown,
          yjsStateBase64: encodeBase64(appliedYjsState),
          stateFingerprint,
          previousYjsStateBase64: encodeBase64(currentYjsState),
          previousStateFingerprint: currentStateFingerprint,
          createdAt: new Date().toISOString(),
        };
        await persistDocumentSnapshot({
          lastDiskHash,
          currentHash,
          currentYjsState,
          lastProjectedMarkdown,
          lastProjectedHash,
          lastProviderStateFingerprint,
          pendingProviderApply: nextPendingProviderApply,
        });
        pendingProviderApply = nextPendingProviderApply;
      },
      async markApplied() {
        const nextPendingProviderApply = {
          markdown,
          yjsStateBase64: encodeBase64(appliedYjsState),
          stateFingerprint,
          ...(pendingProviderApply?.previousYjsStateBase64 ? { previousYjsStateBase64: pendingProviderApply.previousYjsStateBase64 } : {}),
          ...(pendingProviderApply?.previousStateFingerprint ? { previousStateFingerprint: pendingProviderApply.previousStateFingerprint } : {}),
          createdAt: pendingProviderApply?.createdAt ?? new Date().toISOString(),
          providerAppliedAt: new Date().toISOString(),
        };
        await persistDocumentSnapshot({
          lastDiskHash,
          currentHash,
          currentYjsState,
          lastProjectedMarkdown,
          lastProjectedHash,
          lastProviderStateFingerprint,
          pendingProviderApply: nextPendingProviderApply,
        });
        pendingProviderApply = nextPendingProviderApply;
      },
      async commit() {
        await persistDocumentSnapshot({
          lastDiskHash,
          currentHash,
          currentYjsState,
          lastProjectedMarkdown,
          lastProjectedHash,
          lastProviderStateFingerprint,
          pendingProviderApply: null,
        });
        pendingProviderApply = null;
      },
      async abort() {
        await persistDocumentSnapshot({
          lastDiskHash,
          currentHash,
          currentYjsState,
          lastProjectedMarkdown,
          lastProjectedHash,
          lastProviderStateFingerprint,
          pendingProviderApply: null,
        });
        pendingProviderApply = null;
      },
    };
  }

  async function createVersion(
    operation: LocalVersionOperation,
    markdown: string,
    yjsState: Uint8Array,
    hash: string,
    input: { source?: 'agent' | 'user' | 'system'; message?: string | null } = {},
  ): Promise<LocalVersionRecord> {
    const versionNumber = nextVersionNumber();
    const version: LocalVersionRecord = {
      versionId: `${localDocId}-v${versionNumber}`,
      versionNumber,
      operation,
      markdown,
      yjsState: new Uint8Array(yjsState),
      hash,
      source: input.source ?? 'user',
      message: input.message ?? null,
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
      source: version.source,
      message: version.message,
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

  function getVersionByHash(hash: string | null | undefined): LocalVersionRecord | null {
    if (!hash) return null;
    return versions.find((version) => version.hash === hash) ?? null;
  }

  async function requireOpenConflict(conflictId: string): Promise<ReconnectConflict> {
    const candidate = currentOpenConflict?.conflictId === conflictId ? currentOpenConflict : await conflictStore.loadConflict(conflictId);
    if (!candidate || candidate.localPath !== absolutePath) throw new Error('conflict_not_found');
    if (candidate.status !== 'open') throw new Error('conflict_already_resolved');
    return candidate;
  }

  function assertExpectedSharedState(
    openConflict: ReconnectConflict,
    expectedSharedRevision: number,
    expectedSharedHash: string,
  ): void {
    if (expectedSharedRevision !== openConflict.sharedRevision || expectedSharedHash !== openConflict.sharedHash) {
      throw new Error('stale_conflict_shared_state');
    }
  }

  async function markConflictResolved(openConflict: ReconnectConflict): Promise<void> {
    const updated: ReconnectConflict = {
      ...openConflict,
      localMarkdown: currentMarkdown,
      localYjsStateBase64: encodeBase64(currentYjsState),
      localHash: currentHash,
      status: 'resolved',
      updatedAt: new Date().toISOString(),
    };
    await conflictStore.saveConflict(updated);
    if (currentOpenConflict?.conflictId === updated.conflictId) currentOpenConflict = null;
    conflict = null;
  }

  async function replaceCurrentStateFromYjs(yjsState: Uint8Array): Promise<void> {
    const serialized = await documentRuntime.serializeYjsState(yjsState);
    if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
    await writeMarkdownFileAtomically(absolutePath, serialized.markdown);
    currentYjsState = serialized.yjsState;
    currentMarkdown = serialized.markdown;
    currentHash = rawMarkdownHash(serialized.markdown);
    currentStateFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
    markProjectedBaseline(serialized.markdown, currentStateFingerprint);
    await persistCurrentDocument();
  }

  async function replaceCurrentStateFromMarkdown(markdown: string): Promise<void> {
    const applied = await documentRuntime.applyChangedRanges({
      branchId: localDocId,
      yjsState: currentYjsState,
      seedMarkdown: currentMarkdown,
      targetCanonicalMarkdown: markdown,
    });
    if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
    await writeMarkdownFileAtomically(absolutePath, applied.serializedMarkdown);
    currentYjsState = applied.yjsState;
    currentMarkdown = applied.serializedMarkdown;
    currentHash = rawMarkdownHash(applied.serializedMarkdown);
    currentStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
    markProjectedBaseline(applied.serializedMarkdown, currentStateFingerprint);
    await persistCurrentDocument();
  }

  async function createConflictResolutionSnapshot(message: string): Promise<void> {
    await createVersion('conflict_resolved', currentMarkdown, currentYjsState, currentHash, {
      source: 'user',
      message,
    });
  }

  async function updateRelayJoinAfterResolution(
    openConflict: ReconnectConflict,
    sharedRevision: number | null,
  ): Promise<void> {
    if (relayJoinState?.relayRoomId !== openConflict.relayRoomId) return;
    relayJoinState = {
      ...relayJoinState,
      lastAcceptedLocalHash: currentHash,
      lastAcceptedSharedHash: currentHash,
      lastAcceptedSharedRevision: sharedRevision ?? openConflict.sharedRevision,
      lastAcceptedYjsStateBase64: encodeBase64(currentYjsState),
      lastAcceptedStateFingerprint: currentStateFingerprint,
      disconnectedCleanly: true,
      updatedAt: new Date().toISOString(),
    };
    await metadataStore.saveRelayJoin(relayJoinState);
  }

  async function applySerializedRoomState(yjsState: Uint8Array): Promise<PendingProviderApply | null> {
    const serialized = await documentRuntime.serializeYjsState(yjsState);
    if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');

    const nextFingerprint = encodeYjsStateFingerprint(serialized.yjsState);
    const diskMarkdown = await readMarkdownFile(absolutePath);

    const currentStateFingerprintAtDecision = currentStateFingerprint;
    const currentMarkdownAtDecision = currentMarkdown;
    const decision = decideMarkdownReconciliation({
      lastProjectedMarkdown,
      diskMarkdown,
      providerMarkdown: serialized.markdown,
    });

    if (decision.kind === 'conflict') {
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = rawMarkdownHash(serialized.markdown);
      currentStateFingerprint = nextFingerprint;
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'ingest_disk_to_provider') {
      const canIngest = await ensureDiskStillMatches(diskMarkdown);
      if (!canIngest) return null;
      if (
        currentStateFingerprint !== currentStateFingerprintAtDecision
        || currentMarkdown !== currentMarkdownAtDecision
      ) {
        conflict = 'File changed outside MarkLab. Review needed.';
        await createConflictRecoverySnapshot();
        await persistCurrentDocument();
        return null;
      }
      const applied = await documentRuntime.applyChangedRanges({
        branchId: localDocId,
        yjsState: serialized.yjsState,
        seedMarkdown: serialized.markdown,
        targetCanonicalMarkdown: decision.markdown,
      });
      if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
      if (!(await appliedMarkdownMatchesTarget(applied.serializedMarkdown, decision.markdown))) {
        await pauseForProviderApplyDivergence();
        return null;
      }

      const appliedMarkdown = decision.markdown;
      const appliedSerializedMarkdown = applied.serializedMarkdown;
      const appliedHash = rawMarkdownHash(applied.serializedMarkdown);
      const appliedStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
      const pendingApply = createPendingProviderApply(appliedMarkdown, applied.yjsState, appliedStateFingerprint);
      return {
        ...pendingApply,
        async commit() {
          const canCommit = await ensureDiskStillMatches(appliedMarkdown);
          if (!canCommit) return false;
          await persistProjectedDocumentState({
            yjsState: pendingApply.yjsState,
            markdown: appliedSerializedMarkdown,
            hash: appliedHash,
            projectedMarkdown: appliedMarkdown,
            stateFingerprint: appliedStateFingerprint,
          });
          currentYjsState = pendingApply.yjsState;
          currentMarkdown = appliedSerializedMarkdown;
          currentHash = appliedHash;
          currentStateFingerprint = appliedStateFingerprint;
          markProjectedBaseline(appliedMarkdown, appliedStateFingerprint);
          conflict = null;
          return true;
        },
      };
    }

    if (decision.kind === 'noop') {
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = rawMarkdownHash(serialized.markdown);
      currentStateFingerprint = nextFingerprint;
      lastProviderStateFingerprint = nextFingerprint;
      conflict = null;
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'project_provider_to_disk') {
      const canProject = await projectMarkdownToDiskIfUnchanged(diskMarkdown, decision.markdown);
      if (!canProject) return null;
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = rawMarkdownHash(serialized.markdown);
      currentStateFingerprint = nextFingerprint;
      lastProviderStateFingerprint = nextFingerprint;
      markProjectedBaseline(decision.markdown, nextFingerprint);
    } else if (decision.kind === 'accept_converged') {
      const canAccept = await ensureDiskStillMatches(diskMarkdown);
      if (!canAccept) return null;
      currentYjsState = serialized.yjsState;
      currentMarkdown = serialized.markdown;
      currentHash = rawMarkdownHash(serialized.markdown);
      currentStateFingerprint = nextFingerprint;
      lastProviderStateFingerprint = nextFingerprint;
      markProjectedBaseline(decision.markdown, nextFingerprint);
    }

    conflict = null;
    await persistCurrentDocument();
    return null;
  }

  async function applyExternalDiskMarkdown(markdown: string): Promise<PendingProviderApply | null> {
    const diskHash = collabMarkdownHash(markdown);
    if (diskHash === lastProjectedHash) return null;

    const providerStateFingerprintAtDecision = currentStateFingerprint;
    const providerMarkdownAtDecision = currentMarkdown;
    const providerYjsStateAtDecision = new Uint8Array(currentYjsState);
    const decision = decideMarkdownReconciliation({
      lastProjectedMarkdown,
      diskMarkdown: markdown,
      providerMarkdown: providerMarkdownAtDecision,
    });

    if (decision.kind === 'conflict') {
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'noop') return null;

    if (decision.kind === 'accept_converged') {
      const canAccept = await ensureDiskStillMatches(markdown);
      if (!canAccept) return null;
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      await persistCurrentDocument();
      return null;
    }

    if (decision.kind === 'project_provider_to_disk') {
      const canProject = await projectMarkdownToDiskIfUnchanged(markdown, decision.markdown);
      if (!canProject) return null;
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      await persistCurrentDocument();
      return null;
    }

    const canIngest = await ensureDiskStillMatches(markdown);
    if (!canIngest) return null;
    if (
      currentStateFingerprint !== providerStateFingerprintAtDecision
      || currentMarkdown !== providerMarkdownAtDecision
    ) {
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
      return null;
    }
    const applied = await documentRuntime.applyChangedRanges({
      branchId: localDocId,
      yjsState: providerYjsStateAtDecision,
      seedMarkdown: providerMarkdownAtDecision,
      targetCanonicalMarkdown: decision.markdown,
    });
    if (applied.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
    if (!(await appliedMarkdownMatchesTarget(applied.serializedMarkdown, decision.markdown))) {
      await pauseForProviderApplyDivergence();
      return null;
    }

    const appliedMarkdown = decision.markdown;
    const appliedSerializedMarkdown = applied.serializedMarkdown;
    const appliedHash = rawMarkdownHash(applied.serializedMarkdown);
    const appliedStateFingerprint = encodeYjsStateFingerprint(applied.yjsState);
    const pendingApply = createPendingProviderApply(appliedMarkdown, applied.yjsState, appliedStateFingerprint);
    return {
      ...pendingApply,
      async commit() {
        const canCommit = await ensureDiskStillMatches(appliedMarkdown);
        if (!canCommit) return false;
        await persistProjectedDocumentState({
          yjsState: pendingApply.yjsState,
          markdown: appliedSerializedMarkdown,
          hash: appliedHash,
          projectedMarkdown: appliedMarkdown,
          stateFingerprint: appliedStateFingerprint,
        });
        currentYjsState = pendingApply.yjsState;
        currentMarkdown = appliedSerializedMarkdown;
        currentHash = appliedHash;
        currentStateFingerprint = appliedStateFingerprint;
        markProjectedBaseline(appliedMarkdown, appliedStateFingerprint);
        conflict = null;
        return true;
      },
    };
  }

  async function ensureDiskStillMatches(expectedMarkdown: string): Promise<boolean> {
    await options.beforeProjectionWrite?.();
    const latestMarkdown = await readMarkdownFile(absolutePath);
    if (collabMarkdownHash(latestMarkdown) === collabMarkdownHash(expectedMarkdown)) return true;

    await pauseForDiskRaceConflict();
    return false;
  }

  async function pauseForDiskRaceConflict(): Promise<void> {
    conflict = 'File changed outside MarkLab. Review needed.';
    await createConflictRecoverySnapshot();
    await persistCurrentDocument();
  }

  async function pauseForProviderApplyDivergence(): Promise<void> {
    conflict = 'File changed outside MarkLab. Review needed.';
    await createConflictRecoverySnapshot();
    await persistCurrentDocument();
  }

  async function appliedMarkdownMatchesTarget(serializedMarkdown: string, targetMarkdown: string): Promise<boolean> {
    const canonicalSerialized = await documentRuntime.initializeFromMarkdown(serializedMarkdown);
    const canonicalTarget = await documentRuntime.initializeFromMarkdown(targetMarkdown);
    return normalizeCollabMarkdown(canonicalSerialized.markdown) === normalizeCollabMarkdown(canonicalTarget.markdown);
  }

  async function projectMarkdownToDiskIfUnchanged(expectedMarkdown: string, projectedMarkdown: string): Promise<boolean> {
    await options.beforeProjectionWrite?.();
    const latestMarkdown = await readMarkdownFile(absolutePath);
    const expectedHash = collabMarkdownHash(expectedMarkdown);
    if (collabMarkdownHash(latestMarkdown) !== expectedHash) {
      await pauseForDiskRaceConflict();
      return false;
    }

    const projected = await writeMarkdownFileAtomicallyIfUnchanged(
      absolutePath,
      projectedMarkdown,
      expectedHash,
      options.beforeProjectionOpen,
      options.beforeProjectionWrite,
      options.beforeProjectionCommit,
      options.beforeProjectionRename,
    );
    if (!projected) {
      await pauseForDiskRaceConflict();
      return false;
    }
    return true;
  }

  async function reconcileCurrentDiskOnStartup(): Promise<void> {
    if (isRelaySyncPaused()) return;
    const diskMarkdown = await readMarkdownFile(absolutePath);
    if (pendingProviderApply) {
      if (collabMarkdownHash(diskMarkdown) === collabMarkdownHash(pendingProviderApply.markdown)) {
        if (pendingProviderApply.providerAppliedAt) {
          const projectedMarkdown = pendingProviderApply.markdown;
          const stateFingerprint = pendingProviderApply.stateFingerprint;
          const pendingState = await documentRuntime.serializeYjsState(decodeBase64(pendingProviderApply.yjsStateBase64));
          if (pendingState.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
          const canAccept = await ensureDiskStillMatches(projectedMarkdown);
          if (!canAccept) return;
          await persistProjectedDocumentState({
            yjsState: pendingState.yjsState,
            markdown: pendingState.markdown,
            hash: rawMarkdownHash(pendingState.markdown),
            projectedMarkdown,
            stateFingerprint,
          });
          currentYjsState = pendingState.yjsState;
          currentMarkdown = pendingState.markdown;
          currentHash = rawMarkdownHash(pendingState.markdown);
          currentStateFingerprint = stateFingerprint;
          markProjectedBaseline(projectedMarkdown, stateFingerprint);
          conflict = null;
          return;
        }

        if (pendingProviderApply.previousYjsStateBase64) {
          const previousState = await documentRuntime.serializeYjsState(decodeBase64(pendingProviderApply.previousYjsStateBase64));
          if (previousState.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
          currentYjsState = previousState.yjsState;
          currentMarkdown = previousState.markdown;
          currentHash = rawMarkdownHash(previousState.markdown);
          currentStateFingerprint = pendingProviderApply.previousStateFingerprint ?? encodeYjsStateFingerprint(previousState.yjsState);
          pendingProviderApply = null;
          conflict = 'File changed outside MarkLab. Review needed.';
          await createConflictRecoverySnapshot();
          await persistCurrentDocument();
          return;
        }
        if (pendingProviderApply) {
          conflict = 'File changed outside MarkLab. Review needed.';
          await createConflictRecoverySnapshot();
          await persistCurrentDocument();
          return;
        }
      } else {
        pendingProviderApply = null;
      }
    }

    const decision = decideMarkdownReconciliation({
      lastProjectedMarkdown,
      diskMarkdown,
      providerMarkdown: currentMarkdown,
    });

    if (decision.kind === 'noop') {
      lastDiskHash = collabMarkdownHash(diskMarkdown);
      return;
    }

    if (decision.kind === 'conflict') {
      conflict = 'File changed outside MarkLab. Review needed.';
      await createConflictRecoverySnapshot();
      return;
    }

    if (decision.kind === 'project_provider_to_disk') {
      const canProject = await projectMarkdownToDiskIfUnchanged(diskMarkdown, decision.markdown);
      if (!canProject) return;
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      return;
    }

    if (decision.kind === 'accept_converged') {
      const canAccept = await ensureDiskStillMatches(diskMarkdown);
      if (!canAccept) return;
      markProjectedBaseline(decision.markdown, currentStateFingerprint);
      conflict = null;
      return;
    }

    // Disk-only startup edits are reconciled on the first provider flush so the
    // decision can use the provider's current state, not only cached metadata.
    await persistCurrentDocument();
  }

  async function handleWatcherEvent(callbacks: LocalWatcherCallbacks): Promise<void> {
    if (isRelaySyncPaused()) return;
    if (isHandlingWatcherEvent) {
      shouldHandleWatcherAgain = true;
      return;
    }

    isHandlingWatcherEvent = true;
    try {
      do {
        shouldHandleWatcherAgain = false;
        const markdown = await readMarkdownFile(absolutePath);
        if (collabMarkdownHash(markdown) === lastDiskHash) continue;
        await callbacks.flushRoom(roomName);
        if (conflict) return;
        const latestMarkdown = await readMarkdownFile(absolutePath);
        const pendingApply = await applyExternalDiskMarkdown(latestMarkdown);
        if (pendingApply) {
          await pendingApply.prepare();
          try {
            await callbacks.applyRoomState(roomName, pendingApply.yjsState);
          } catch (error) {
            await pendingApply.abort();
            throw error;
          }
          await pendingApply.markApplied();
          await pendingApply.commit();
        }
      } while (shouldHandleWatcherAgain);
    } finally {
      isHandlingWatcherEvent = false;
    }
  }

  if (backingFileMissingOnStartup) {
    conflict = 'host_file_missing';
    await createConflictRecoverySnapshot();
  } else if (hasStoredDocument) {
    await reconcileCurrentDiskOnStartup();
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
      if (pendingProviderApply) {
        return {
          yjsState: decodeBase64(pendingProviderApply.yjsStateBase64),
          stateFingerprint: pendingProviderApply.stateFingerprint,
        };
      }
      return {
        yjsState: new Uint8Array(currentYjsState),
        stateFingerprint: currentStateFingerprint,
      };
    },
    async storeRoomState(candidateRoomName, yjsState, expectedStateFingerprint) {
      assertRoom(candidateRoomName);
      if (isRelaySyncPaused()) throw new Error('conflict_required');
      const incomingFingerprint = encodeYjsStateFingerprint(yjsState);
      if (
        pendingProviderApply
        && expectedStateFingerprint === pendingProviderApply.stateFingerprint
        && incomingFingerprint === pendingProviderApply.stateFingerprint
      ) {
        const pendingSnapshot = pendingProviderApply;
        const serialized = await documentRuntime.serializeYjsState(yjsState);
        if (serialized.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
        return {
          stored: true,
          stateFingerprint: pendingSnapshot.stateFingerprint,
          yjsState: serialized.yjsState,
          prepare: async () => undefined,
          markApplied: async () => {
            pendingProviderApply = {
              ...pendingSnapshot,
              providerAppliedAt: pendingSnapshot.providerAppliedAt ?? new Date().toISOString(),
            };
            await persistCurrentDocument();
          },
          commit: async () => {
            const diskMarkdown = await readMarkdownFile(absolutePath);
            if (collabMarkdownHash(diskMarkdown) !== collabMarkdownHash(pendingSnapshot.markdown)) {
              await pauseForDiskRaceConflict();
              return false;
            }
            await persistProjectedDocumentState({
              yjsState: serialized.yjsState,
              markdown: serialized.markdown,
              hash: rawMarkdownHash(serialized.markdown),
              projectedMarkdown: pendingSnapshot.markdown,
              stateFingerprint: pendingSnapshot.stateFingerprint,
            });
            currentYjsState = serialized.yjsState;
            currentMarkdown = serialized.markdown;
            currentHash = rawMarkdownHash(serialized.markdown);
            currentStateFingerprint = pendingSnapshot.stateFingerprint;
            markProjectedBaseline(pendingSnapshot.markdown, pendingSnapshot.stateFingerprint);
            conflict = null;
            return true;
          },
          abort: async () => undefined,
        };
      }
      if (expectedStateFingerprint !== null && expectedStateFingerprint !== currentStateFingerprint) {
        throw new Error('local_state_changed');
      }
      const pendingApply = await applySerializedRoomState(yjsState);
      if (isRelaySyncPaused()) {
        return {
          stored: false,
          stateFingerprint: currentStateFingerprint,
        };
      }
      return {
        stored: true,
        stateFingerprint: pendingApply?.stateFingerprint ?? currentStateFingerprint,
        ...(pendingApply
          ? {
              yjsState: pendingApply.yjsState,
              prepare: pendingApply.prepare,
              markApplied: pendingApply.markApplied,
              commit: pendingApply.commit,
              abort: pendingApply.abort,
            }
          : {}),
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
    getRelayHostState() {
      return relayHostState ? { ...relayHostState } : null;
    },
    async saveRelayHostState(state) {
      relayHostState = { ...state };
      await metadataStore.saveRelayHost(relayHostState);
    },
    async clearRelayHostState() {
      relayHostState = null;
      await metadataStore.clearRelayHost(localDocId);
    },
    getRelayJoinState() {
      return relayJoinState ? { ...relayJoinState } : null;
    },
    async saveRelayJoinState(state) {
      relayJoinState = { ...state };
      await metadataStore.saveRelayJoin(relayJoinState);
    },
    isBackingFileAvailable() {
      return existsSync(absolutePath);
    },
    async pauseForMissingBackingFile(kind) {
      conflict = kind === 'host' ? 'host_file_missing' : 'mirror_file_missing';
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
    },
    async pauseForRelayConflict(message) {
      conflict = message;
      await createConflictRecoverySnapshot();
      await persistCurrentDocument();
    },
    getCurrentConflict() {
      return currentOpenConflict ? { ...currentOpenConflict } : null;
    },
    async getConflict(conflictId) {
      const candidate = currentOpenConflict?.conflictId === conflictId ? currentOpenConflict : await conflictStore.loadConflict(conflictId);
      return candidate && candidate.localPath === absolutePath ? { ...candidate } : null;
    },
    async openReconnectConflict(input) {
      if (currentOpenConflict?.status === 'open') return { ...currentOpenConflict };
      const sharedYjsState = decodeBase64(input.sharedYjsStateBase64);
      const shared = await documentRuntime.serializeYjsState(sharedYjsState);
      if (shared.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
      const baseVersion = getVersionByHash(input.baseHash ?? relayJoinState?.lastAcceptedLocalHash);
      let baseMarkdown = input.baseMarkdown ?? baseVersion?.markdown ?? null;
      let baseYjsStateBase64 = input.baseYjsStateBase64 ?? (baseVersion ? encodeBase64(baseVersion.yjsState) : null);
      if (!baseMarkdown && baseYjsStateBase64) {
        const base = await documentRuntime.serializeYjsState(decodeBase64(baseYjsStateBase64));
        if (base.yjsState.byteLength > 0) {
          baseMarkdown = base.markdown;
          baseYjsStateBase64 = encodeBase64(base.yjsState);
        }
      }
      const now = new Date().toISOString();
      const openConflict: ReconnectConflict = {
        conflictId: `conflict_${randomUUID()}`,
        relayRoomId: input.relayRoomId,
        localDocId,
        localPath: absolutePath,
        baseMarkdown,
        baseYjsStateBase64,
        baseHash: input.baseHash ?? baseVersion?.hash ?? null,
        localMarkdown: currentMarkdown,
        localYjsStateBase64: encodeBase64(currentYjsState),
        localHash: currentHash,
        sharedMarkdown: shared.markdown,
        sharedYjsStateBase64: encodeBase64(shared.yjsState),
        sharedHash: input.sharedHash ?? rawMarkdownHash(shared.markdown),
        sharedStateFingerprint: encodeYjsStateFingerprint(shared.yjsState),
        sharedRevision: input.sharedRevision,
        createdAt: now,
        updatedAt: now,
        status: 'open',
      };
      currentOpenConflict = openConflict;
      conflict = 'Relay reconnect conflict. Review needed before syncing resumes.';
      await conflictStore.saveConflict(openConflict);
      await createVersion('conflict_opened', currentMarkdown, currentYjsState, currentHash, {
        source: 'system',
        message: 'Reconnect conflict opened',
      });
      await persistCurrentDocument();
      return { ...openConflict };
    },
    async prepareUseSharedConflict(conflictId) {
      const openConflict = await requireOpenConflict(conflictId);
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying shared conflict version');
      await replaceCurrentStateFromYjs(decodeBase64(openConflict.sharedYjsStateBase64));
      if (relayJoinState?.relayRoomId === openConflict.relayRoomId) {
        relayJoinState = {
          ...relayJoinState,
          lastAcceptedLocalHash: currentHash,
          lastAcceptedSharedHash: openConflict.sharedHash,
          lastAcceptedSharedRevision: openConflict.sharedRevision,
          lastAcceptedYjsStateBase64: encodeBase64(currentYjsState),
          lastAcceptedStateFingerprint: currentStateFingerprint,
          disconnectedCleanly: true,
          updatedAt: new Date().toISOString(),
        };
        await metadataStore.saveRelayJoin(relayJoinState);
      }
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        hash: currentHash,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async prepareUseLocalConflict(conflictId, expectedSharedRevision, expectedSharedHash) {
      const openConflict = await requireOpenConflict(conflictId);
      assertExpectedSharedState(
        openConflict,
        expectedSharedRevision ?? openConflict.sharedRevision,
        expectedSharedHash ?? openConflict.sharedHash,
      );
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying local conflict version');
      await replaceCurrentStateFromMarkdown(openConflict.localMarkdown);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        hash: currentHash,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async prepareResolvedConflict(conflictId, markdown, expectedSharedRevision, expectedSharedHash) {
      const openConflict = await requireOpenConflict(conflictId);
      assertExpectedSharedState(openConflict, expectedSharedRevision, expectedSharedHash);
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying pasted conflict resolution');
      await replaceCurrentStateFromMarkdown(markdown);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        hash: currentHash,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async completeConflictResolution(conflictId, sharedRevision) {
      const openConflict = await requireOpenConflict(conflictId);
      await updateRelayJoinAfterResolution(openConflict, sharedRevision);
      await createConflictResolutionSnapshot('Post-resolution snapshot after conflict side effects completed');
      await markConflictResolved(openConflict);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        status: 'resolved',
        hash: currentHash,
        sharedRevision,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async useSharedConflict(conflictId) {
      const openConflict = await requireOpenConflict(conflictId);
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying shared conflict version');
      await replaceCurrentStateFromYjs(decodeBase64(openConflict.sharedYjsStateBase64));
      await updateRelayJoinAfterResolution(openConflict, openConflict.sharedRevision);
      await createConflictResolutionSnapshot('Post-resolution snapshot after conflict side effects completed');
      await markConflictResolved(openConflict);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        status: 'resolved',
        hash: currentHash,
        sharedRevision: openConflict.sharedRevision,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async useLocalConflict(conflictId, expectedSharedRevision, expectedSharedHash) {
      const openConflict = await requireOpenConflict(conflictId);
      assertExpectedSharedState(
        openConflict,
        expectedSharedRevision ?? openConflict.sharedRevision,
        expectedSharedHash ?? openConflict.sharedHash,
      );
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying local conflict version');
      await replaceCurrentStateFromMarkdown(openConflict.localMarkdown);
      await updateRelayJoinAfterResolution(openConflict, openConflict.sharedRevision);
      await createConflictResolutionSnapshot('Post-resolution snapshot after conflict side effects completed');
      await markConflictResolved(openConflict);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        status: 'resolved',
        hash: currentHash,
        sharedRevision: openConflict.sharedRevision,
        yjsState: new Uint8Array(currentYjsState),
      };
    },
    async resolveConflict(conflictId, markdown, expectedSharedRevision, expectedSharedHash) {
      const openConflict = await requireOpenConflict(conflictId);
      assertExpectedSharedState(openConflict, expectedSharedRevision, expectedSharedHash);
      await createConflictRecoverySnapshot();
      await createConflictResolutionSnapshot('Pre-resolution snapshot before applying pasted conflict resolution');
      await replaceCurrentStateFromMarkdown(markdown);
      await updateRelayJoinAfterResolution(openConflict, openConflict.sharedRevision);
      await createConflictResolutionSnapshot('Post-resolution snapshot after conflict side effects completed');
      await markConflictResolved(openConflict);
      await persistCurrentDocument();
      return {
        conflictId: openConflict.conflictId,
        status: 'resolved',
        hash: currentHash,
        sharedRevision: openConflict.sharedRevision,
        yjsState: new Uint8Array(currentYjsState),
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
    async createManualVersion(input = {}) {
      if (isRelaySyncPaused()) throw new Error('conflict_required');
      const latest = versions.at(-1);
      if (latest?.hash === currentHash) {
        return {
          created: false,
          versionId: latest.versionId,
          versionNumber: latest.versionNumber,
          hash: latest.hash,
          source: latest.source,
          message: latest.message,
        };
      }

      const version = await createVersion('manual_save', currentMarkdown, currentYjsState, currentHash, input);
      await persistCurrentDocument();
      return {
        created: true,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        hash: version.hash,
        source: version.source,
        message: version.message,
      };
    },
    async restoreVersion(versionId) {
      if (isRelaySyncPaused()) throw new Error('conflict_required');
      const source = versions.find((candidate) => candidate.versionId === versionId);
      if (!source) throw new Error('local_version_not_found');
      const diskMarkdown = await readMarkdownFile(absolutePath);
      const diskHash = rawMarkdownHash(diskMarkdown);
      if (currentHash !== source.hash) {
        await createVersion('pre_restore', currentMarkdown, currentYjsState, currentHash);
      }
      if (diskHash !== source.hash && diskHash !== currentHash) {
        const diskState = await documentRuntime.initializeFromMarkdown(diskMarkdown);
        if (diskState.yjsState.byteLength === 0) throw new Error('invalid_live_yjs_state');
        await createVersion('pre_restore', diskMarkdown, diskState.yjsState, diskHash);
      }

      const applied = await documentRuntime.applyChangedRanges({
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
      markProjectedBaseline(applied.serializedMarkdown, currentStateFingerprint);
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
