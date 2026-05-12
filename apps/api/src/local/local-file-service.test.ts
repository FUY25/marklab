import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import { encodeYjsStateFingerprint } from '../services/yjs-state-fingerprint';
import { createLocalFileServiceWithOptions, type LocalFileService } from './local-file-service';
import type { LocalMetadataStore, StoredLocalDocument, StoredLocalRelayHostState, StoredLocalRelayJoinState, StoredLocalVersion } from './local-metadata-store';

const runtime = createHeadlessMilkdownRuntime();

async function createTempMarkdown(markdown: string): Promise<{ directory: string; file: string; metadataPath: string; conflictPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'marklab-local-file-'));
  const file = join(directory, 'note.md');
  const metadataPath = join(directory, 'metadata', 'marklab-local.json');
  const conflictPath = join(directory, 'metadata', 'marklab-conflicts.json');
  await mkdir(join(directory, 'metadata'), { recursive: true });
  await writeFile(file, markdown, 'utf8');
  return { directory, file, metadataPath, conflictPath };
}

async function readFixture(name: string): Promise<string> {
  return readFile(resolve('fixtures', name), 'utf8');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 100);
    });
  }
  throw new Error('timed_out_waiting');
}

async function applyExternalChange(service: LocalFileService, file: string, markdown: string): Promise<void> {
  service.startWatcher({
    flushRoom: async () => undefined,
    applyRoomState: async () => undefined,
  });
  const previousHash = service.getSummary().hash;
  await new Promise((resolveReady) => {
    setTimeout(resolveReady, 25);
  });
  await writeFile(file, markdown, 'utf8');
  try {
    await waitFor(() => service.getSummary().hash !== previousHash);
  } catch (error) {
    throw new Error(`timed_out_waiting:${JSON.stringify(service.getSummary())}`, { cause: error });
  }
  service.stopWatcher();
}

function createInMemoryMetadataStore(): LocalMetadataStore & {
  failDocumentSaves: boolean;
  savedDocuments: StoredLocalDocument[];
} {
  let document: StoredLocalDocument | null = null;
  let relayHost: StoredLocalRelayHostState | null = null;
  let relayJoin: StoredLocalRelayJoinState | null = null;
  const versions: StoredLocalVersion[] = [];
  const store: LocalMetadataStore & {
    failDocumentSaves: boolean;
    savedDocuments: StoredLocalDocument[];
  } = {
    failDocumentSaves: false,
    savedDocuments: [],
    async loadDocument(absolutePath) {
      return document?.absolutePath === absolutePath ? document : null;
    },
    async saveDocument(nextDocument) {
      if (store.failDocumentSaves) throw new Error('metadata_save_failed');
      document = structuredClone(nextDocument);
      store.savedDocuments.push(structuredClone(nextDocument));
    },
    async listVersions(localDocId) {
      return versions.filter((version) => version.localDocId === localDocId);
    },
    async appendVersion(version) {
      versions.push(structuredClone(version));
    },
    async loadRelayJoin(absolutePath) {
      return relayJoin?.absolutePath === absolutePath ? relayJoin : null;
    },
    async saveRelayJoin(state) {
      relayJoin = structuredClone(state);
    },
    async clearRelayJoin() {
      relayJoin = null;
    },
    async loadRelayHost(absolutePath) {
      return relayHost?.absolutePath === absolutePath ? relayHost : null;
    },
    async saveRelayHost(state) {
      relayHost = structuredClone(state);
    },
    async clearRelayHost() {
      relayHost = null;
    },
  };
  return store;
}

describe('LocalFileService', () => {
  it('opens Markdown fixtures without rewriting the canonical file', async () => {
    for (const fixtureName of ['03_code_mermaid_frontmatter.md', '04_math_links_images.md', '02_table.md']) {
      const markdown = await readFixture(fixtureName);
      const { file, metadataPath } = await createTempMarkdown(markdown);

      const service = await createLocalFileServiceWithOptions(file, { metadataPath });

      expect(await readFile(file, 'utf8')).toBe(markdown);
      service.stopWatcher();
    }
  });

  it('persists snapshots and restores them after recreating the daemon service', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Versioned\n\nInitial.\n');
    const firstService = await createLocalFileServiceWithOptions(file, { metadataPath });
    const savedMarkdown = '# Versioned\n\nSaved snapshot.\n';
    await applyExternalChange(firstService, file, savedMarkdown);

    const saved = await firstService.createManualVersion();
    expect(saved.created).toBe(true);
    firstService.stopWatcher();

    const restartedService = await createLocalFileServiceWithOptions(file, { metadataPath });
    const versions = restartedService.listVersions();
    const manualVersion = versions.find((version) => version.operation === 'manual_save');
    expect(manualVersion).toBeDefined();
    expect(restartedService.getVersion(manualVersion!.versionId).markdown).toContain('Saved snapshot.');

    await writeFile(file, '# Versioned\n\nChanged after restart.\n', 'utf8');
    await restartedService.restoreVersion(manualVersion!.versionId);

    expect(await readFile(file, 'utf8')).toContain('Saved snapshot.');
    restartedService.stopWatcher();
  }, 10_000);

  it('preserves unapplied external disk markdown and live browser state before restore overwrite', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Restore\n\nBase.\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const sourceVersion = service.listVersions().find((version) => version.operation === 'open');
    if (!sourceVersion) throw new Error('missing_open_version');
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const browserDraft = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Restore\n\nBase.\n',
      targetCanonicalMarkdown: '# Restore\n\nBrowser draft.\n',
    });
    await service.storeRoomState(service.roomName, browserDraft.yjsState, loaded.stateFingerprint);

    await writeFile(file, '# Restore\n\nExternal disk save.\n', 'utf8');
    await service.restoreVersion(sourceVersion.versionId);

    const preRestoreMarkdowns = service
      .listVersions()
      .filter((version) => version.operation === 'pre_restore')
      .map((version) => service.getVersion(version.versionId).markdown);
    expect(preRestoreMarkdowns).toContain('# Restore\n\nBrowser draft.\n');
    expect(preRestoreMarkdowns).toContain('# Restore\n\nExternal disk save.\n');
    expect(await readFile(file, 'utf8')).toBe('# Restore\n\nBase.\n');
    service.stopWatcher();
  });

  it('does not overwrite an external disk save when browser state flushes from a stale base', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Conflict\n\nBase.\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const dirty = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Conflict\n\nBase.\n',
      targetCanonicalMarkdown: '# Conflict\n\nBrowser draft.\n',
    });

    await writeFile(file, '# Conflict\n\nExternal save.\n', 'utf8');
    await service.storeRoomState(service.roomName, dirty.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Conflict\n\nExternal save.\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    expect(service.listVersions().some((version) => version.operation === 'conflict_recovery')).toBe(true);
    service.stopWatcher();
  });

  it('projects remote provider changes when disk stayed at last projected baseline', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Remote\n');
    expect(service.getSummary().conflict).toBeNull();
    service.stopWatcher();
  });

  it('does not let stale disk overwrite remote provider changes after restart', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: first.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote while app closed\n',
    });
    first.stopWatcher();

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    await restarted.storeRoomState(restarted.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Remote while app closed\n');
    expect(restarted.getSummary().conflict).toBeNull();
    restarted.stopWatcher();
  });

  it('pauses projection instead of recreating a missing backing file on startup', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    await first.loadRoomState(first.roomName);
    first.stopWatcher();

    await rm(file);

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });

    expect(restarted.isBackingFileAvailable?.()).toBe(false);
    expect(restarted.getSummary().conflict).toBe('host_file_missing');
    restarted.stopWatcher();
  });

  it('ingests a disk-only edit made while the daemon was stopped on restart', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const initial = await first.loadRoomState(first.roomName);
    if (!initial) throw new Error('missing_initial_state');
    first.stopWatcher();

    await writeFile(file, '# Local while closed\n', 'utf8');

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await restarted.loadRoomState(restarted.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    expect(loaded.stateFingerprint).toBe(initial.stateFingerprint);

    const stored = await restarted.storeRoomState(restarted.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.commit?.();
    const accepted = await restarted.loadRoomState(restarted.roomName);
    if (!accepted) throw new Error('missing_accepted_state');
    const serialized = await runtime.serializeYjsState(accepted.yjsState);

    expect(serialized.markdown).toBe('# Local while closed\n');
    expect(await readFile(file, 'utf8')).toBe('# Local while closed\n');
    expect(restarted.getSummary().conflict).toBeNull();
    restarted.stopWatcher();
  });

  it('does not commit a stopped-daemon disk edit if the disk changes after provider apply', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const initial = await first.loadRoomState(first.roomName);
    if (!initial) throw new Error('missing_initial_state');
    first.stopWatcher();

    await writeFile(file, '# Local while closed\n', 'utf8');

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await restarted.loadRoomState(restarted.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const stored = await restarted.storeRoomState(restarted.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.markApplied?.();

    await writeFile(file, '# Local changed after provider apply\n', 'utf8');
    const committed = await stored.commit?.();
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string; providerAppliedAt?: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(committed).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('# Local changed after provider apply\n');
    expect(restarted.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(initial.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toMatchObject({
      markdown: '# Local while closed\n',
      providerAppliedAt: expect.any(String),
    });
    restarted.stopWatcher();
  });

  it('opens a conflict when provider and disk both changed while the daemon was stopped', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: first.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote while closed\n',
    });
    first.stopWatcher();

    await writeFile(file, '# Local while closed\n', 'utf8');

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const stored = await restarted.storeRoomState(restarted.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(stored.stored).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('# Local while closed\n');
    expect(restarted.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterConflict = await restarted.loadRoomState(restarted.roomName);
    if (!afterConflict) throw new Error('missing_after_conflict_state');
    expect(afterConflict.stateFingerprint).toBe(encodeYjsStateFingerprint(remote.yjsState));
    restarted.stopWatcher();
  });

  it('returns updated room state when a provider flush sees a disk-only edit', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before provider flush\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    const serialized = await runtime.serializeYjsState(stored.yjsState);
    await stored.prepare?.();
    const preparedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, { pendingProviderApply?: { markdown: string; stateFingerprint: string } }>;
    };
    const preparedDocument = Object.values(preparedMetadata.documents)[0];
    expect(preparedDocument?.pendingProviderApply).toMatchObject({
      markdown: '# Local before provider flush\n',
      stateFingerprint: stored.stateFingerprint,
    });
    await stored.commit?.();
    const committedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, { pendingProviderApply?: unknown }>;
    };
    expect(Object.values(committedMetadata.documents)[0]?.pendingProviderApply).toBeUndefined();

    expect(serialized.markdown).toBe('# Local before provider flush\n');
    expect(service.getSummary().conflict).toBeNull();
    service.stopWatcher();
  });

  it('does not commit a live disk edit if the disk changes after provider apply', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before provider flush\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.markApplied?.();

    await writeFile(file, '# Local changed after provider apply\n', 'utf8');
    const committed = await stored.commit?.();
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string; providerAppliedAt?: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(committed).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('# Local changed after provider apply\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toMatchObject({
      markdown: '# Local before provider flush\n',
      providerAppliedAt: expect.any(String),
    });
    service.stopWatcher();
  });

  it('does not advance in-memory baseline when pending provider commit metadata persistence fails', async () => {
    const { file } = await createTempMarkdown('# Base\n');
    const metadataStore = createInMemoryMetadataStore();
    const service = await createLocalFileServiceWithOptions(file, { metadataStore });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before failed commit\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    metadataStore.failDocumentSaves = true;

    await expect(stored.commit?.()).rejects.toThrow('metadata_save_failed');

    const latestSavedDocument = metadataStore.savedDocuments.at(-1);
    if (!latestSavedDocument) throw new Error('missing_saved_document');
    const savedCurrent = await runtime.serializeYjsState(Buffer.from(latestSavedDocument.currentYjsStateBase64, 'base64'));
    expect(savedCurrent.markdown).toBe('# Base\n');
    expect(latestSavedDocument.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(latestSavedDocument.pendingProviderApply).toMatchObject({ markdown: '# Local before failed commit\n' });
    service.stopWatcher();
  });

  it('clears a prepared disk-to-provider state when the pending apply is aborted', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before abort\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();

    const preparedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, { pendingProviderApply?: { markdown: string } }>;
    };
    expect(Object.values(preparedMetadata.documents)[0]?.pendingProviderApply).toMatchObject({ markdown: '# Local before abort\n' });

    await stored.abort?.();

    const abortedMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, { pendingProviderApply?: unknown }>;
    };
    expect(Object.values(abortedMetadata.documents)[0]?.pendingProviderApply).toBeUndefined();
    service.stopWatcher();
  });

  it('pauses ingestion when the provider apply serializes to different markdown than the disk target', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const divergingRuntime = {
      initializeFromMarkdown: runtime.initializeFromMarkdown.bind(runtime),
      serializeYjsState: runtime.serializeYjsState.bind(runtime),
      async applyChangedRanges(input: Parameters<typeof runtime.applyChangedRanges>[0]) {
        const applied = await runtime.applyChangedRanges(input);
        return { ...applied, serializedMarkdown: '# Diverged\n' };
      },
    };
    const service = await createLocalFileServiceWithOptions(file, { metadataPath, runtime: divergingRuntime });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local target\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);

    expect(stored.stored).toBe(false);
    expect(stored.yjsState).toBeUndefined();
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    service.stopWatcher();
  });

  it('does not commit an unconfirmed prepared disk-to-provider state after daemon restart when disk matches pending markdown', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before crash\n', 'utf8');
    const stored = await first.storeRoomState(first.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    first.stopWatcher();

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const recovered = await restarted.loadRoomState(restarted.roomName);
    if (!recovered) throw new Error('missing_recovered_state');
    const serialized = await runtime.serializeYjsState(recovered.yjsState);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(serialized.markdown).toBe('# Base\n');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toBeUndefined();
    expect(restarted.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    restarted.stopWatcher();
  });

  it('does not promote an unconfirmed disk-to-provider state after two daemon restarts before provider flush', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before crash\n', 'utf8');
    const stored = await first.storeRoomState(first.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    first.stopWatcher();

    const firstRestart = await createLocalFileServiceWithOptions(file, { metadataPath });
    firstRestart.stopWatcher();
    const secondRestart = await createLocalFileServiceWithOptions(file, { metadataPath });
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        currentYjsStateBase64?: string;
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];
    const currentState = await runtime.serializeYjsState(Buffer.from(documentMetadata?.currentYjsStateBase64 ?? '', 'base64'));

    expect(currentState.markdown).toBe('# Base\n');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toBeUndefined();

    const recovered = await secondRestart.loadRoomState(secondRestart.roomName);
    if (!recovered) throw new Error('missing_recovered_state');
    const flushed = await secondRestart.storeRoomState(secondRestart.roomName, recovered.yjsState, recovered.stateFingerprint);
    if (!flushed.yjsState) throw new Error('missing_updated_state');
    await flushed.prepare?.();
    await flushed.commit?.();
    const accepted = await secondRestart.loadRoomState(secondRestart.roomName);
    if (!accepted) throw new Error('missing_accepted_state');
    const acceptedState = await runtime.serializeYjsState(accepted.yjsState);
    expect(acceptedState.markdown).toBe('# Local before crash\n');
    secondRestart.stopWatcher();
  });

  it('clears a confirmed prepared disk-to-provider state after daemon restart when disk matches pending markdown', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before crash\n', 'utf8');
    const stored = await first.storeRoomState(first.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.markApplied?.();
    first.stopWatcher();

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const recovered = await restarted.loadRoomState(restarted.roomName);
    if (!recovered) throw new Error('missing_recovered_state');
    const serialized = await runtime.serializeYjsState(recovered.yjsState);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(serialized.markdown).toBe('# Local before crash\n');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Local before crash\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(recovered.stateFingerprint);
    expect(documentMetadata?.lastProviderStateFingerprint).not.toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toBeUndefined();
    restarted.stopWatcher();
  });

  it('does not clear a confirmed prepared disk-to-provider state when disk changes during restart recovery', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before crash\n', 'utf8');
    const stored = await first.storeRoomState(first.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.markApplied?.();
    first.stopWatcher();

    let injectedRace = false;
    const restarted = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionWrite() {
        if (injectedRace) return;
        injectedRace = true;
        await writeFile(file, '# Local after recovered provider apply\n', 'utf8');
      },
    });
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string; providerAppliedAt?: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(await readFile(file, 'utf8')).toBe('# Local after recovered provider apply\n');
    expect(restarted.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toMatchObject({
      markdown: '# Local before crash\n',
      providerAppliedAt: expect.any(String),
    });
    restarted.stopWatcher();
  });

  it('does not commit a recovered pending provider apply when disk changes before metadata commit', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before commit\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    await stored.markApplied?.();

    const recovered = await service.loadRoomState(service.roomName);
    if (!recovered) throw new Error('missing_recovered_state');
    const pendingCommit = await service.storeRoomState(service.roomName, recovered.yjsState, recovered.stateFingerprint);
    if (!pendingCommit.yjsState) throw new Error('missing_pending_commit_state');
    await writeFile(file, '# Local before recovered commit finishes\n', 'utf8');
    const committed = await pendingCommit.commit?.();

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProjectedMarkdown?: string;
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string; providerAppliedAt?: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(committed).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('# Local before recovered commit finishes\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    expect(documentMetadata?.lastProjectedMarkdown).toBe('# Base\n');
    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toMatchObject({
      markdown: '# Local before commit\n',
      providerAppliedAt: expect.any(String),
    });
    service.stopWatcher();
  });

  it('defers a newer offline disk edit over a stale prepared provider apply until provider flush', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const first = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await first.loadRoomState(first.roomName);
    if (!loaded) throw new Error('missing_loaded_state');

    await writeFile(file, '# Local before crash\n', 'utf8');
    const stored = await first.storeRoomState(first.roomName, loaded.yjsState, loaded.stateFingerprint);
    if (!stored.yjsState) throw new Error('missing_updated_state');
    await stored.prepare?.();
    first.stopWatcher();

    await writeFile(file, '# Local after crash\n', 'utf8');

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath });
    const recovered = await restarted.loadRoomState(restarted.roomName);
    if (!recovered) throw new Error('missing_recovered_state');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, {
        lastProviderStateFingerprint?: string;
        pendingProviderApply?: { markdown: string };
      }>;
    };
    const documentMetadata = Object.values(metadata.documents)[0];

    expect(documentMetadata?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(documentMetadata?.pendingProviderApply).toBeUndefined();

    const flushed = await restarted.storeRoomState(restarted.roomName, recovered.yjsState, recovered.stateFingerprint);
    if (!flushed.yjsState) throw new Error('missing_updated_state');
    await flushed.prepare?.();
    await flushed.commit?.();
    const accepted = await restarted.loadRoomState(restarted.roomName);
    if (!accepted) throw new Error('missing_accepted_state');
    const serialized = await runtime.serializeYjsState(accepted.yjsState);
    expect(serialized.markdown).toBe('# Local after crash\n');
    restarted.stopWatcher();
  });

  it('pauses sync when disk and provider both diverged from last projected baseline', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await writeFile(file, '# Local\n', 'utf8');
    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    await expect(service.storeRoomState(service.roomName, remote.yjsState, null)).rejects.toThrow('conflict_required');
    service.stopWatcher();
  });

  it('does not mark a provider fingerprint as projected when both sides conflict', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await writeFile(file, '# Local\n', 'utf8');
    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      documents: Record<string, { lastProviderStateFingerprint?: string }>;
    };
    const storedDocument = Object.values(metadata.documents)[0];
    expect(storedDocument?.lastProviderStateFingerprint).toBe(loaded.stateFingerprint);
    expect(storedDocument?.lastProviderStateFingerprint).not.toBe(encodeYjsStateFingerprint(remote.yjsState));
    service.stopWatcher();
  });

  it('does not overwrite a disk edit that races with provider projection', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionWrite() {
        if (injectedRace) return;
        injectedRace = true;
        await writeFile(file, '# Local race\n', 'utf8');
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local race\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('does not overwrite a disk edit that lands after provider projection verification', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    let projectionCheckCount = 0;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionWrite() {
        projectionCheckCount += 1;
        if (projectionCheckCount === 2) await writeFile(file, '# Local late race\n', 'utf8');
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local late race\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('does not overwrite a disk edit that appears after the final projection check before replace', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionCommit() {
        if (injectedRace) return;
        injectedRace = true;
        await writeFile(file, '# Local final race\n', 'utf8');
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local final race\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('does not overwrite an atomic-save disk edit that appears before provider projection replace', async () => {
    const { directory, file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionCommit() {
        if (injectedRace) return;
        injectedRace = true;
        const replacementPath = join(directory, 'replacement-note.md');
        await writeFile(replacementPath, '# Local atomic save\n', 'utf8');
        await rename(replacementPath, file);
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local atomic save\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('restores a disk edit that lands after the final projection check before replace', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionRename() {
        if (injectedRace) return;
        injectedRace = true;
        await writeFile(file, '# Local post-check race\n', 'utf8');
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local post-check race\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('restores an atomic-save disk edit that lands after the final projection check before replace', async () => {
    const { directory, file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionRename() {
        if (injectedRace) return;
        injectedRace = true;
        const replacementPath = join(directory, 'post-check-replacement.md');
        await writeFile(replacementPath, '# Local post-check atomic save\n', 'utf8');
        await rename(replacementPath, file);
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(await readFile(file, 'utf8')).toBe('# Local post-check atomic save\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(loaded.stateFingerprint);
    service.stopWatcher();
  });

  it('cleans projection temp files and pauses when the backing file disappears before replace', async () => {
    const { directory, file, metadataPath } = await createTempMarkdown('# Base\n');
    let injectedRace = false;
    const service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionOpen() {
        if (injectedRace) return;
        injectedRace = true;
        await rm(file, { force: true });
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote\n',
    });

    await service.storeRoomState(service.roomName, remote.yjsState, loaded.stateFingerprint);

    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const leakedTempFiles = (await readdir(directory)).filter((entry) => entry.includes('.marklab-') && entry.endsWith('.tmp'));
    expect(leakedTempFiles).toEqual([]);
    service.stopWatcher();
  });

  it('pauses disk-to-provider ingestion when provider state changes during disk verification', async () => {
    const { file, metadataPath } = await createTempMarkdown('# Base\n');
    let service: LocalFileService | null = null;
    let remoteYjsState: Uint8Array | null = null;
    let remoteFingerprint = '';
    let injectedProviderChange = false;
    service = await createLocalFileServiceWithOptions(file, {
      metadataPath,
      async beforeProjectionWrite() {
        if (injectedProviderChange || !service || !remoteYjsState) return;
        injectedProviderChange = true;
        await service.storeRoomState(service.roomName, remoteYjsState, null);
      },
    });
    const loaded = await service.loadRoomState(service.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    const remote = await runtime.applyChangedRanges({
      branchId: service.getSummary().localDocId,
      yjsState: loaded.yjsState,
      seedMarkdown: '# Base\n',
      targetCanonicalMarkdown: '# Remote concurrent\n',
    });
    remoteYjsState = remote.yjsState;
    remoteFingerprint = encodeYjsStateFingerprint(remote.yjsState);

    await writeFile(file, '# Local disk\n', 'utf8');
    const stored = await service.storeRoomState(service.roomName, loaded.yjsState, loaded.stateFingerprint);

    expect(stored.stored).toBe(false);
    expect(stored.yjsState).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('# Local disk\n');
    expect(service.getSummary().conflict).toBe('File changed outside MarkLab. Review needed.');
    const afterRace = await service.loadRoomState(service.roomName);
    if (!afterRace) throw new Error('missing_after_race_state');
    expect(afterRace.stateFingerprint).toBe(remoteFingerprint);
    service.stopWatcher();
  });

  it('keeps relay reconnect sync paused after recreating the daemon service', async () => {
    const { file, metadataPath, conflictPath } = await createTempMarkdown('# Local offline\n');
    const service = await createLocalFileServiceWithOptions(file, { metadataPath, conflictPath });
    const shared = await runtime.initializeFromMarkdown('# Shared online\n');

    const conflict = await service.openReconnectConflict({
      relayRoomId: 'relay_1',
      sharedRevision: 3,
      sharedHash: shared.hash,
      sharedYjsStateBase64: Buffer.from(shared.yjsState).toString('base64'),
      baseMarkdown: null,
      baseYjsStateBase64: null,
      baseHash: null,
    });
    expect(conflict.status).toBe('open');
    service.stopWatcher();

    const restarted = await createLocalFileServiceWithOptions(file, { metadataPath, conflictPath });
    expect(restarted.getCurrentConflict()).toMatchObject({
      conflictId: conflict.conflictId,
      status: 'open',
      localMarkdown: '# Local offline\n',
      sharedMarkdown: '# Shared online\n',
    });

    const loaded = await restarted.loadRoomState(restarted.roomName);
    if (!loaded) throw new Error('missing_loaded_state');
    await expect(restarted.storeRoomState(restarted.roomName, loaded.yjsState, loaded.stateFingerprint)).rejects.toThrow(
      'conflict_required',
    );
    restarted.stopWatcher();
  });

  it('round-trips supported Markdown through external edit, room state, and disk save', async () => {
    for (const fixtureName of ['03_code_mermaid_frontmatter.md', '04_math_links_images.md', '02_table.md']) {
      const markdown = await readFixture(fixtureName);
      const { file, metadataPath } = await createTempMarkdown(markdown);
      const service = await createLocalFileServiceWithOptions(file, { metadataPath });
      const externalMarkdown = `${markdown.trimEnd()}\n\nExternal editor note.\n`;
      await applyExternalChange(service, file, externalMarkdown);
      const loaded = await service.loadRoomState(service.roomName);
      if (!loaded) throw new Error('missing_loaded_state');
      const browserMarkdown = `${externalMarkdown.trimEnd()}\n\nBrowser round trip.\n`;
      const browserState = await runtime.applyChangedRanges({
        branchId: service.getSummary().localDocId,
        yjsState: loaded.yjsState,
        seedMarkdown: externalMarkdown,
        targetCanonicalMarkdown: browserMarkdown,
      });

      await service.storeRoomState(service.roomName, browserState.yjsState, loaded.stateFingerprint);
      const diskMarkdown = await readFile(file, 'utf8');

      expect(diskMarkdown).toContain('External editor note.');
      expect(diskMarkdown).toContain('Browser round trip.');
      if (fixtureName.includes('03_')) {
        expect(diskMarkdown).toContain('```mermaid');
        expect(diskMarkdown).toContain('owner: team');
      }
      if (fixtureName.includes('04_')) {
        expect(diskMarkdown).toContain('$E = mc^2$');
        expect(diskMarkdown).toContain('![Diagram](./diagram.png)');
      }
      if (fixtureName.includes('02_')) {
        expect(diskMarkdown).toContain('| Segment');
        expect(diskMarkdown).toContain('Enterprise');
      }
      service.stopWatcher();
    }
  }, 15_000);
});
