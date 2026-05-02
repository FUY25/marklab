import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createHeadlessMilkdownRuntime } from '../services/milkdown-headless-runtime';
import { createLocalFileServiceWithOptions, type LocalFileService } from './local-file-service';

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
  await writeFile(file, markdown, 'utf8');
  await waitFor(() => service.getSummary().hash !== previousHash);
  service.stopWatcher();
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
  });

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
  });
});
