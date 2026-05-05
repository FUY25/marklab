import { Modal, Notice, Plugin } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { resolveActiveMarkdownFilePath, resolveMarkdownFilePath, humanizeActiveNoteError } from './active-note';
import {
  MarkLabCliAdapter,
  humanizeCliError,
  type MarkLabCreatedLinkResponse,
  type MarkLabLinkRole,
  type MarkLabShareStateResponse,
  type MarkLabStatusEntry,
} from './cli-adapter';
import { buildAiHandoffInstructions } from './handoff';
import { DEFAULT_SETTINGS, MarkLabSettingTab, normalizeSettings, type MarkLabPluginSettings } from './settings';
import { sharingBlockReason } from './share-guard';
import {
  MarkLabSharingModal,
  type MarkLabBatchShareScope,
  type MarkLabShareableMarkdownFile,
} from './sharing-modal';

interface MarkLabLinkSetEntry {
  label: string;
  filePath: string;
  role: MarkLabLinkRole;
  url: string;
}

interface MarkLabLinkSetFailure {
  label: string;
  filePath: string;
  message: string;
}

interface MarkLabLinkSetResult {
  scope: MarkLabBatchShareScope;
  role: MarkLabLinkRole;
  links: MarkLabLinkSetEntry[];
  failures: MarkLabLinkSetFailure[];
}

class TextModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly paragraphs: string[],
    private readonly selectableText?: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.title });
    for (const paragraph of this.paragraphs) {
      contentEl.createEl('p', { text: paragraph });
    }
    if (this.selectableText) {
      const textarea = contentEl.createEl('textarea');
      textarea.value = this.selectableText;
      textarea.rows = Math.min(12, Math.max(3, this.selectableText.split('\n').length));
      textarea.readOnly = true;
      textarea.addClass('marklab-selectable-text');
      textarea.select();
    }
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onResolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    const actions = contentEl.createDiv({ cls: 'modal-button-container' });
    const confirmButton = actions.createEl('button', { text: this.confirmText });
    confirmButton.addClass('mod-cta');
    confirmButton.addEventListener('click', () => {
      this.onResolve(true);
      this.close();
    });

    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.onResolve(false);
      this.close();
    });
  }

  onClose(): void {
    this.onResolve(false);
  }
}

function confirmAction(app: App, title: string, message: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const modal = new ConfirmModal(app, title, message, confirmText, (confirmed) => {
      if (resolved) return;
      resolved = true;
      resolve(confirmed);
    });
    modal.open();
  });
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isLocalDaemonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.startsWith('/local') && url.hash.includes('token=');
  } catch {
    return false;
  }
}

function statusLabel(entry: MarkLabStatusEntry | undefined, shareState: MarkLabShareStateResponse | null): string {
  if (!entry || entry.daemon === 'missing') return 'Not hosted';
  if (entry.hasConflict || entry.syncState === 'paused') return 'Paused or conflicted';
  if (entry.syncState === 'host_offline') return 'Host offline';
  if (entry.syncState === 'error') return 'Status unavailable';
  if (shareState?.shareState.relayRoomId || entry.relayRoomId) return 'Hosting and synced';
  if (entry.daemon === 'running') return 'Open locally and synced';
  return entry.syncState;
}

export default class MarkLabPlugin extends Plugin {
  settings: MarkLabPluginSettings = DEFAULT_SETTINGS;
  private cli = new MarkLabCliAdapter({ command: DEFAULT_SETTINGS.cliCommand });

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.rebuildCliAdapter();
    this.addSettingTab(new MarkLabSettingTab(this.app, this));

    const ribbonIcon = this.addRibbonIcon('share-2', 'MarkLab sharing', () => {
      this.openSharingPanel();
    });
    ribbonIcon.addClass('marklab-ribbon-sharing');

    this.addCommand({
      id: 'open-sharing-panel',
      name: 'Open sharing panel',
      callback: () => {
        this.openSharingPanel();
      },
    });

    this.addCommand({
      id: 'check-setup',
      name: 'Check setup',
      callback: () => {
        void this.checkSetup(true);
      },
    });

    this.addCommand({
      id: 'share-current-note',
      name: 'Share current note',
      callback: () => {
        void this.shareCurrentNote();
      },
    });

    this.addCommand({
      id: 'create-edit-link-current-note',
      name: 'Create edit link for current note',
      callback: () => {
        void this.createLinkForCurrentNote('edit');
      },
    });

    this.addCommand({
      id: 'create-view-link-current-note',
      name: 'Create view link for current note',
      callback: () => {
        void this.createLinkForCurrentNote('view');
      },
    });

    this.addCommand({
      id: 'show-current-note-status',
      name: 'Show current note status',
      callback: () => {
        void this.showCurrentNoteStatus();
      },
    });

    this.addCommand({
      id: 'open-current-note',
      name: 'Open current note in MarkLab',
      callback: () => {
        void this.openCurrentNote();
      },
    });

    this.addCommand({
      id: 'copy-ai-handoff-instructions',
      name: 'Copy AI handoff instructions',
      callback: () => {
        void this.copyAiHandoffInstructions();
      },
    });

    this.addCommand({
      id: 'stop-sharing-current-note',
      name: 'Stop sharing current note',
      callback: () => {
        void this.stopSharingCurrentNote();
      },
    });
  }

  async saveSettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  rebuildCliAdapter(): void {
    this.cli = new MarkLabCliAdapter({
      command: this.settings.cliCommand,
      relayUrlOverride: this.settings.relayUrlOverride,
    });
  }

  private async checkSetup(showSuccessNotice = false): Promise<boolean> {
    let setup: Awaited<ReturnType<MarkLabCliAdapter['checkSetup']>>;
    try {
      setup = await this.cli.checkSetup();
    } catch (error) {
      new TextModal(this.app, 'MarkLab setup', [
        humanizeCliError(error),
        'Check the CLI command setting and try again.',
      ]).open();
      return false;
    }

    if (setup.available) {
      if (showSuccessNotice) new Notice('MarkLab CLI is available.');
      return true;
    }

    new TextModal(this.app, 'MarkLab setup', [
      setup.message,
      'Install the MarkLab CLI yourself, then update the CLI command setting if needed.',
      'Suggested command setting after install: marklab',
      'You can also use npx -y @marklab/cli as the command setting for testing.',
    ]).open();
    return false;
  }

  private activeMarkdownPath(): string | null {
    try {
      return resolveActiveMarkdownFilePath(this.app);
    } catch (error) {
      new Notice(humanizeActiveNoteError(error));
      return null;
    }
  }

  private openSharingPanel(): void {
    const markdownFiles = this.markdownFileChoices();
    if (markdownFiles.length === 0) {
      new Notice('No Markdown pages are available to share with MarkLab.');
      return;
    }

    new MarkLabSharingModal(this.app, {
      defaultRole: this.settings.defaultLinkRole,
      markdownFiles,
      createSinglePageLink: (filePath, role) => this.createLinkForFile(filePath, role),
      createLinkSet: (files, role, scope) => this.createLinksForFiles(files, role, scope),
    }).open();
  }

  private markdownFileChoices(): MarkLabShareableMarkdownFile[] {
    const activeFile = this.app.workspace.getActiveFile() as TFile | null;
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => ({
        label: file.path,
        filePath: resolveMarkdownFilePath(this.app, file),
        isActive: file.path === activeFile?.path,
      }))
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }

  private async ensureHosted(
    filePath: string,
    options: { confirmBeforeHosting?: boolean; openBrowser?: boolean } = {},
  ): Promise<boolean> {
    const confirmBeforeHosting = options.confirmBeforeHosting ?? true;
    const openBrowser = options.openBrowser ?? true;
    const status = await this.cli.status(filePath);
    const entry = status.files[0];
    if (entry?.daemon === 'running') {
      const blockReason = sharingBlockReason(entry);
      if (blockReason) {
        new Notice(blockReason);
        return false;
      }
      return true;
    }

    if (this.settings.backgroundHostingPreference === 'never') {
      new Notice('This note is not hosted by MarkLab. Background hosting is disabled in settings.');
      return false;
    }

    if (confirmBeforeHosting) {
      const confirmed = await confirmAction(
        this.app,
        'Start MarkLab hosting?',
        'MarkLab will start a persistent local background daemon for this note so relay links can work while the daemon remains online.',
        'Start hosting',
      );
      if (!confirmed) return false;
    }

    await this.cli.openBackground(filePath, { openBrowser });
    return true;
  }

  private async shareCurrentNote(): Promise<void> {
    await this.createLinkForCurrentNote(this.settings.defaultLinkRole);
  }

  private async createLinkForCurrentNote(role: MarkLabLinkRole): Promise<boolean> {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return false;
    return this.createLinkForFile(filePath, role);
  }

  private async createLinkForFile(filePath: string, role: MarkLabLinkRole): Promise<boolean> {
    if (!(await this.checkSetup())) return false;

    try {
      if (!(await this.ensureHosted(filePath))) return false;
      const link = await this.cli.createLink(filePath, role);
      await this.presentCreatedLink(link);
      return true;
    } catch (error) {
      new Notice(humanizeCliError(error));
      return false;
    }
  }

  private async createLinksForFiles(
    files: MarkLabShareableMarkdownFile[],
    role: MarkLabLinkRole,
    scope: MarkLabBatchShareScope,
  ): Promise<boolean> {
    if (files.length === 0) {
      new Notice('Choose at least one Markdown page before creating MarkLab links.');
      return false;
    }

    const confirmed = await this.confirmBatchSharing(files.length, role, scope);
    if (!confirmed) return false;
    if (!(await this.checkSetup())) return false;

    const result: MarkLabLinkSetResult = {
      scope,
      role,
      links: [],
      failures: [],
    };

    for (const file of files) {
      try {
        const hosted = await this.ensureHosted(file.filePath, {
          confirmBeforeHosting: false,
          openBrowser: false,
        });
        if (!hosted) {
          result.failures.push({
            label: file.label,
            filePath: file.filePath,
            message: 'MarkLab could not start or verify background hosting for this page.',
          });
          continue;
        }

        const link = await this.cli.createLink(file.filePath, role);
        if (isLocalDaemonUrl(link.url)) {
          result.failures.push({
            label: file.label,
            filePath: file.filePath,
            message: 'MarkLab returned a local daemon URL, not a relay link.',
          });
          continue;
        }

        result.links.push({
          label: file.label,
          filePath: file.filePath,
          role: link.role,
          url: link.url,
        });
      } catch (error) {
        result.failures.push({
          label: file.label,
          filePath: file.filePath,
          message: humanizeCliError(error),
        });
      }
    }

    await this.presentCreatedLinkSet(result);
    return result.links.length > 0;
  }

  private confirmBatchSharing(fileCount: number, role: MarkLabLinkRole, scope: MarkLabBatchShareScope): Promise<boolean> {
    const title = scope === 'vault' ? 'Share vault Markdown?' : 'Create MarkLab link set?';
    const pageLabel = `${fileCount} Markdown page${fileCount === 1 ? '' : 's'}`;
    const scopeCopy =
      scope === 'vault'
        ? `MarkLab will create one ${role} relay link for each of the ${pageLabel} in this vault. Attachments and non-Markdown files are excluded.`
        : `MarkLab will create one ${role} relay link for each of the ${pageLabel} you selected.`;
    return confirmAction(
      this.app,
      title,
      `${scopeCopy} This may start local background hosting for each page, but it will not open a browser tab for every file.`,
      'Create links',
    );
  }

  private async presentCreatedLink(link: MarkLabCreatedLinkResponse): Promise<void> {
    if (isLocalDaemonUrl(link.url)) {
      new Notice('MarkLab returned a local daemon URL, so it was not copied as a share link.');
      return;
    }

    const copied = this.settings.copyCreatedLinksAutomatically ? await copyToClipboard(link.url) : false;
    if (copied) {
      new Notice(`Copied MarkLab ${link.role} link.`);
      return;
    }

    new TextModal(this.app, `MarkLab ${link.role} link`, ['Copy this relay link and send it to your collaborator.'], link.url).open();
  }

  private async presentCreatedLinkSet(result: MarkLabLinkSetResult): Promise<void> {
    const scopeLabel = result.scope === 'vault' ? 'vault Markdown' : 'multiple pages';
    const title = result.links.length > 0 ? `MarkLab ${result.role} link set` : 'MarkLab link set failed';
    const summary = `Created ${result.links.length} link${result.links.length === 1 ? '' : 's'} for ${scopeLabel}.`;
    const failureSummary =
      result.failures.length > 0 ? `${result.failures.length} page${result.failures.length === 1 ? '' : 's'} could not be shared.` : '';
    const text = this.formatLinkSet(result, scopeLabel);

    if (result.links.length > 0 && result.failures.length === 0 && this.settings.copyCreatedLinksAutomatically) {
      const copied = await copyToClipboard(text);
      if (copied) {
        new Notice(`Copied MarkLab ${result.role} link set for ${result.links.length} page${result.links.length === 1 ? '' : 's'}.`);
        return;
      }
    }

    const paragraphs = failureSummary
      ? [summary, failureSummary, 'Copy the links that were created successfully, and review any failed pages below.']
      : [summary, 'Copy these relay links and send them to your collaborator.'];
    new TextModal(this.app, title, paragraphs, text).open();
  }

  private formatLinkSet(result: MarkLabLinkSetResult, scopeLabel: string): string {
    const lines = [
      `MarkLab ${result.role} link set (${scopeLabel})`,
      `Created: ${result.links.length}`,
      `Failed: ${result.failures.length}`,
      '',
    ];

    if (result.links.length > 0) {
      lines.push('Links:');
      for (const link of result.links) {
        lines.push(`- ${link.label}: ${link.url}`);
      }
      lines.push('');
    }

    if (result.failures.length > 0) {
      lines.push('Failures:');
      for (const failure of result.failures) {
        lines.push(`- ${failure.label}: ${failure.message}`);
      }
    }

    return lines.join('\n').trimEnd();
  }

  private async showCurrentNoteStatus(): Promise<void> {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!(await this.checkSetup())) return;

    try {
      const status = await this.cli.status(filePath);
      const entry = status.files[0];
      let shareState: MarkLabShareStateResponse | null = null;
      if (entry?.daemon === 'running') {
        try {
          shareState = await this.cli.shareState(filePath);
        } catch {
          shareState = null;
        }
      }

      const linkCount = shareState?.shareState.links?.length ?? 0;
      const paragraphs = [
        `File: ${filePath}`,
        `State: ${statusLabel(entry, shareState)}`,
        `Relay room: ${shareState?.shareState.relayRoomId ?? entry?.relayRoomId ?? 'not shared'}`,
        `Host online: ${shareState?.shareState.hostOnline === undefined ? 'unknown' : shareState.shareState.hostOnline ? 'yes' : 'no'}`,
        `Links: ${linkCount}`,
      ];
      new TextModal(this.app, 'MarkLab status', paragraphs).open();
    } catch (error) {
      new Notice(humanizeCliError(error));
    }
  }

  private async openCurrentNote(): Promise<void> {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!(await this.checkSetup())) return;

    try {
      const status = await this.cli.status(filePath);
      const alreadyRunning = status.files[0]?.daemon === 'running';
      if (!alreadyRunning) {
        const confirmed = await confirmAction(
          this.app,
          'Open in MarkLab?',
          'MarkLab will start persistent local background hosting for this note and open the local browser editor.',
          'Open',
        );
        if (!confirmed) return;
      }
      await this.cli.openBackground(filePath);
      new Notice('Opened current note in MarkLab.');
    } catch (error) {
      new Notice(humanizeCliError(error));
    }
  }

  private async copyAiHandoffInstructions(): Promise<void> {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;

    const instructions = buildAiHandoffInstructions({
      filePath,
      cliCommand: this.settings.cliCommand,
    });
    const copied = await copyToClipboard(instructions);
    if (copied) {
      new Notice('Copied MarkLab AI handoff instructions.');
      return;
    }

    new TextModal(this.app, 'MarkLab AI handoff instructions', ['Copy these instructions into your local AI agent.'], instructions).open();
  }

  private async stopSharingCurrentNote(): Promise<void> {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!(await this.checkSetup())) return;

    const confirmed = await confirmAction(
      this.app,
      'Stop sharing?',
      'MarkLab will stop the local daemon for this note. Existing relay links will not work while the host is offline.',
      'Stop sharing',
    );
    if (!confirmed) return;

    try {
      await this.cli.stop(filePath);
      new Notice('Stopped MarkLab sharing for this note.');
    } catch (error) {
      new Notice(humanizeCliError(error));
    }
  }
}
