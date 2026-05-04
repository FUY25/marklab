import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';

export type MarkLabLinkRole = 'view' | 'edit';
export type BackgroundHostingPreference = 'ask' | 'never';

export interface MarkLabPluginSettings {
  cliCommand: string;
  relayUrlOverride: string;
  defaultLinkRole: MarkLabLinkRole;
  backgroundHostingPreference: BackgroundHostingPreference;
  copyCreatedLinksAutomatically: boolean;
}

export const DEFAULT_SETTINGS: MarkLabPluginSettings = {
  cliCommand: 'marklab',
  relayUrlOverride: '',
  defaultLinkRole: 'view',
  backgroundHostingPreference: 'ask',
  copyCreatedLinksAutomatically: true,
};

export function normalizeSettings(data: Partial<MarkLabPluginSettings> | null | undefined): MarkLabPluginSettings {
  const defaultLinkRole = data?.defaultLinkRole === 'edit' ? 'edit' : 'view';
  const backgroundHostingPreference = data?.backgroundHostingPreference === 'never' ? 'never' : 'ask';
  return {
    cliCommand: data?.cliCommand?.trim() || DEFAULT_SETTINGS.cliCommand,
    relayUrlOverride: data?.relayUrlOverride?.trim() || DEFAULT_SETTINGS.relayUrlOverride,
    defaultLinkRole,
    backgroundHostingPreference,
    copyCreatedLinksAutomatically: data?.copyCreatedLinksAutomatically ?? DEFAULT_SETTINGS.copyCreatedLinksAutomatically,
  };
}

export type MarkLabSettingsHost = Plugin & {
  settings: MarkLabPluginSettings;
  saveSettings(): Promise<void>;
  rebuildCliAdapter(): void;
};

export class MarkLabSettingTab extends PluginSettingTab {
  private readonly plugin: MarkLabSettingsHost;

  constructor(app: App, plugin: MarkLabSettingsHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'MarkLab' });

    new Setting(containerEl)
      .setName('CLI command')
      .setDesc('Command used to run MarkLab. Use marklab by default, or a command such as npx -y @marklab/cli.')
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.cliCommand)
          .setValue(this.plugin.settings.cliCommand)
          .onChange(async (value) => {
            this.plugin.settings.cliCommand = value.trim() || DEFAULT_SETTINGS.cliCommand;
            this.plugin.rebuildCliAdapter();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Hosted relay URL override')
      .setDesc('Optional self-hosted relay base URL. Leave blank to use the MarkLab CLI default.')
      .addText((text) => {
        text
          .setPlaceholder('https://marklab-relay-alpha.fly.dev')
          .setValue(this.plugin.settings.relayUrlOverride)
          .onChange(async (value) => {
            this.plugin.settings.relayUrlOverride = value.trim();
            this.plugin.rebuildCliAdapter();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Default link role')
      .setDesc('Role used by Share current note.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('view', 'View')
          .addOption('edit', 'Edit')
          .setValue(this.plugin.settings.defaultLinkRole)
          .onChange(async (value) => {
            this.plugin.settings.defaultLinkRole = value === 'edit' ? 'edit' : 'view';
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Background hosting')
      .setDesc('Choose whether MarkLab can offer to start persistent background hosting for the active note.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('ask', 'Ask before starting')
          .addOption('never', 'Never start automatically')
          .setValue(this.plugin.settings.backgroundHostingPreference)
          .onChange(async (value) => {
            this.plugin.settings.backgroundHostingPreference = value === 'never' ? 'never' : 'ask';
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Copy created links automatically')
      .setDesc('Copy new MarkLab relay links to the clipboard after creation.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.copyCreatedLinksAutomatically)
          .onChange(async (value) => {
            this.plugin.settings.copyCreatedLinksAutomatically = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
