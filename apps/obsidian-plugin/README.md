# MarkLab for Obsidian

MarkLab for Obsidian is a desktop-only control panel for sharing the active Markdown note through the existing MarkLab CLI, local daemon, browser editor, and hosted relay.

The vault Markdown file remains the canonical document. The plugin does not port the MarkLab sync engine into Obsidian and does not create a hosted document workspace.

## Commands

- `MarkLab: Open sharing panel`
- `MarkLab: Check setup`
- `MarkLab: Share current note`
- `MarkLab: Create edit link for current note`
- `MarkLab: Create view link for current note`
- `MarkLab: Show current note status`
- `MarkLab: Open current note in MarkLab`
- `MarkLab: Copy AI handoff instructions`
- `MarkLab: Stop sharing current note`

The left ribbon MarkLab icon opens the sharing panel. The panel can create edit or view links for any selected Markdown note in the vault, selected Markdown notes, or all Markdown notes in the vault.

Multi-page and whole-vault sharing currently create a link set: one MarkLab relay link per Markdown file. Attachments and non-Markdown files are excluded. A later MarkLab collection-link feature can replace the link set with a single share URL once the CLI, relay, and browser UI support true multi-file collections.

## Requirements

- Obsidian desktop.
- MarkLab CLI available on your machine. The default command is `marklab`; you can change it in plugin settings.

The plugin never silently installs the CLI. If the CLI is unavailable, the setup command shows guidance and leaves installation to you.

## Network And Filesystem Disclosure

MarkLab uses hosted relay endpoints when you create edit or view links. The relay coordinates rooms, permissions, host presence, and ephemeral sync state so browser collaborators can reach the note while your host daemon is online.

The plugin accesses the active Markdown note path through Obsidian's vault APIs, then passes that local file path to the MarkLab CLI. The MarkLab CLI and local daemon may read and write MarkLab metadata, local versions, and conflict metadata in MarkLab-managed local storage. The plugin does not store raw local daemon tokens, raw relay access tokens, or generated share links in plugin settings.

The local browser editor URL can contain a local daemon token. The plugin does not display or copy that local URL as a share link. Share commands use MarkLab relay links created by the CLI.

## Consent And Privacy

- No client-side telemetry is included.
- No dynamic ads are loaded from the internet.
- No self-update mechanism is included.
- No code is obfuscated to hide its purpose.
- No vault content is uploaded or shared without an explicit command.
- Starting persistent background hosting requires confirmation. Multi-page and whole-vault sharing ask once before creating the batch of relay links.

The MVP does not require a MarkLab account and does not require payment. If hosted relay accounts, paid capacity, or server-side telemetry are introduced later, this README must be updated before release.

## Local Testing

Build the plugin:

```sh
pnpm --filter @marklab/obsidian-plugin build
```

Copy `manifest.json` and `main.js` into a test vault:

```sh
mkdir -p "/path/to/test-vault/.obsidian/plugins/marklab"
cp apps/obsidian-plugin/manifest.json apps/obsidian-plugin/main.js "/path/to/test-vault/.obsidian/plugins/marklab/"
```

Enable the plugin from Obsidian desktop, then run the MarkLab commands from the command palette.

## Release Notes

For beta or Community Plugin release, create GitHub release assets whose tag matches `manifest.json` version. Upload:

- `main.js`
- `manifest.json`
- `styles.css`, if one is added later

Before Community Plugin submission, the repository also needs a maintainer-selected `LICENSE` file.
