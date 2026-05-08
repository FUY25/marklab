import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { MarkLabLinkRole } from './cli-adapter';

export type MarkLabShareScope = 'single' | 'multiple' | 'vault';
export type MarkLabBatchShareScope = Exclude<MarkLabShareScope, 'single'>;

export interface MarkLabShareableMarkdownFile {
  label: string;
  filePath: string;
  isActive: boolean;
}

export interface MarkLabSharingModalOptions {
  defaultRole: MarkLabLinkRole;
  markdownFiles: MarkLabShareableMarkdownFile[];
  createSinglePageLink(filePath: string, role: MarkLabLinkRole): Promise<boolean>;
  createLinkSet(files: MarkLabShareableMarkdownFile[], role: MarkLabLinkRole, scope: MarkLabBatchShareScope): Promise<boolean>;
}

export function normalizeShareScope(value: string): MarkLabShareScope {
  if (value === 'multiple' || value === 'vault') return value;
  return 'single';
}

export class MarkLabSharingModal extends Modal {
  private shareScope: MarkLabShareScope = 'single';
  private role: MarkLabLinkRole;
  private selectedFilePath: string;
  private readonly selectedMultipleFilePaths = new Set<string>();

  constructor(
    app: App,
    private readonly options: MarkLabSharingModalOptions,
  ) {
    super(app);
    this.role = options.defaultRole;
    this.selectedFilePath = options.markdownFiles.find((file) => file.isActive)?.filePath ?? options.markdownFiles[0]?.filePath ?? '';
    const defaultMultipleSelection = options.markdownFiles.filter((file) => file.isActive).map((file) => file.filePath);
    for (const filePath of defaultMultipleSelection.length > 0 ? defaultMultipleSelection : [this.selectedFilePath]) {
      if (filePath) this.selectedMultipleFilePaths.add(filePath);
    }
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'MarkLab sharing' });
    contentEl.createEl('p', {
      text: 'Create MarkLab relay links for Markdown files in this vault.',
    });

    new Setting(contentEl)
      .setName('Scope')
      .setDesc('Single-page, multiple-page, and vault Markdown sharing are available as explicit scopes.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('single', 'Single Markdown page')
          .addOption('multiple', 'Multiple Markdown pages')
          .addOption('vault', 'Entire vault Markdown')
          .setValue(this.shareScope)
          .onChange((value) => {
            this.shareScope = normalizeShareScope(value);
            this.render();
          });
      });

    if (this.shareScope === 'single') {
      this.renderSinglePage();
      return;
    }

    if (this.shareScope === 'multiple') {
      this.renderMultiplePages();
      return;
    }

    this.renderVault();
  }

  private renderSinglePage(): void {
    const { contentEl } = this;
    const selectedFile = this.options.markdownFiles.find((file) => file.filePath === this.selectedFilePath);

    contentEl.createEl('h3', { text: 'Single Markdown page' });
    contentEl.createEl('p', {
      text: selectedFile?.isActive
        ? `Active note: ${selectedFile.label}`
        : 'Choose the Markdown page to share. The vault file remains the canonical source.',
    });

    new Setting(contentEl)
      .setName('Markdown page')
      .setDesc('Pick one Markdown file from this vault.')
      .addDropdown((dropdown) => {
        for (const file of this.options.markdownFiles) {
          dropdown.addOption(file.filePath, file.isActive ? `${file.label} (active)` : file.label);
        }
        dropdown.setValue(this.selectedFilePath).onChange((value) => {
          this.selectedFilePath = value;
          this.render();
        });
      });

    new Setting(contentEl)
      .setName('Link role')
      .setDesc('Edit links allow collaborators to write. View links are read-only.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('view', 'View')
          .addOption('edit', 'Edit')
          .setValue(this.role)
          .onChange((value) => {
            this.role = value === 'edit' ? 'edit' : 'view';
            this.render();
          });
      });

    const actions = contentEl.createDiv({ cls: 'modal-button-container' });
    const createButton = actions.createEl('button', { text: `Create ${this.role} link` });
    createButton.addClass('mod-cta');
    createButton.addEventListener('click', () => {
      void this.createLink(createButton);
    });

    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  private renderMultiplePages(): void {
    const { contentEl } = this;
    const selectedFiles = this.selectedMultipleFiles();

    contentEl.createEl('h3', { text: 'Multiple Markdown pages' });
    contentEl.createEl('p', {
      text: 'Create a shareable link set with one MarkLab relay link per selected Markdown page.',
    });

    new Setting(contentEl)
      .setName('Link role')
      .setDesc('The same role is used for every selected page.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('view', 'View')
          .addOption('edit', 'Edit')
          .setValue(this.role)
          .onChange((value) => {
            this.role = value === 'edit' ? 'edit' : 'view';
            this.render();
          });
      });

    const selectionControls = contentEl.createDiv({ cls: 'marklab-share-selection-controls' });
    const selectAllButton = selectionControls.createEl('button', { text: 'Select all' });
    selectAllButton.addEventListener('click', () => {
      this.selectedMultipleFilePaths.clear();
      for (const file of this.options.markdownFiles) this.selectedMultipleFilePaths.add(file.filePath);
      this.render();
    });

    const clearButton = selectionControls.createEl('button', { text: 'Clear' });
    clearButton.addEventListener('click', () => {
      this.selectedMultipleFilePaths.clear();
      this.render();
    });

    const list = contentEl.createDiv({ cls: 'marklab-share-file-list' });
    for (const file of this.options.markdownFiles) {
      const row = list.createEl('label');
      row.addClass('marklab-share-file-option');
      const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
      checkbox.checked = this.selectedMultipleFilePaths.has(file.filePath);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.selectedMultipleFilePaths.add(file.filePath);
        } else {
          this.selectedMultipleFilePaths.delete(file.filePath);
        }
        this.render();
      });
      row.createEl('span', { text: file.isActive ? `${file.label} (active)` : file.label });
    }

    const actions = contentEl.createDiv({ cls: 'modal-button-container' });
    const createButton = actions.createEl('button', { text: `Create ${this.role} links (${selectedFiles.length})` });
    createButton.addClass('mod-cta');
    createButton.disabled = selectedFiles.length === 0;
    createButton.addEventListener('click', () => {
      void this.createLinkSet(createButton, selectedFiles, 'multiple');
    });

    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  private renderVault(): void {
    const { contentEl } = this;
    const files = this.options.markdownFiles;

    contentEl.createEl('h3', { text: 'Entire vault Markdown' });
    contentEl.createEl('p', {
      text: `Create a shareable link set for all ${files.length} Markdown page${files.length === 1 ? '' : 's'} in this vault. Attachments and non-Markdown files are excluded.`,
    });
    contentEl.createEl('p', {
      text: 'You will be asked to confirm before MarkLab starts background hosting or creates relay links for the vault.',
    });

    new Setting(contentEl)
      .setName('Link role')
      .setDesc('The same role is used for every Markdown page in the vault.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('view', 'View')
          .addOption('edit', 'Edit')
          .setValue(this.role)
          .onChange((value) => {
            this.role = value === 'edit' ? 'edit' : 'view';
            this.render();
          });
      });

    const actions = contentEl.createDiv({ cls: 'modal-button-container' });
    const createButton = actions.createEl('button', { text: `Create ${this.role} links (${files.length})` });
    createButton.addClass('mod-cta');
    createButton.disabled = files.length === 0;
    createButton.addEventListener('click', () => {
      void this.createLinkSet(createButton, files, 'vault');
    });

    const closeButton = actions.createEl('button', { text: 'Close' });
    closeButton.addEventListener('click', () => {
      this.close();
    });
  }

  private async createLink(createButton: HTMLButtonElement): Promise<void> {
    if (!this.selectedFilePath) {
      new Notice('Choose a Markdown page before creating a MarkLab link.');
      return;
    }

    const previousText = createButton.textContent ?? `Create ${this.role} link`;
    createButton.disabled = true;
    createButton.textContent = 'Creating link...';

    try {
      const created = await this.options.createSinglePageLink(this.selectedFilePath, this.role);
      if (created) {
        this.close();
        return;
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }

    createButton.disabled = false;
    createButton.textContent = previousText;
  }

  private selectedMultipleFiles(): MarkLabShareableMarkdownFile[] {
    return this.options.markdownFiles.filter((file) => this.selectedMultipleFilePaths.has(file.filePath));
  }

  private async createLinkSet(
    createButton: HTMLButtonElement,
    files: MarkLabShareableMarkdownFile[],
    scope: MarkLabBatchShareScope,
  ): Promise<void> {
    if (files.length === 0) {
      new Notice('Choose at least one Markdown page before creating MarkLab links.');
      return;
    }

    const previousText = createButton.textContent ?? `Create ${this.role} links`;
    createButton.disabled = true;
    createButton.textContent = 'Creating links...';

    try {
      const created = await this.options.createLinkSet(files, this.role, scope);
      if (created) {
        this.close();
        return;
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }

    createButton.disabled = false;
    createButton.textContent = previousText;
  }
}
