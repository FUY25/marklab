# MarkLab Obsidian Plugin Product Requirements

Date: 2026-05-04

## Summary

MarkLab for Obsidian should let an individual Obsidian user share the current Markdown note with a friend or AI collaborator without moving the source of truth out of the vault.

The first plugin release is a desktop-first, thin wrapper over the existing MarkLab CLI, local daemon, browser editor, and hosted relay. Obsidian provides the native entry point. MarkLab continues to own file watching, local versions, conflict review, browser collaboration, hosted edit/view links, and AI-agent coordination.

The design principles are:

- Local-first: the vault Markdown file remains canonical.
- AI-first: agents operate on local files and use MarkLab CLI/status/version commands for coordination.
- Consent-first: sharing, CLI installation, daemon launch, and network use require explicit user action.
- Free plugin: monetization belongs to hosted relay capacity and support tiers, not a paid plugin install.

## Goals

- Share the active Obsidian Markdown file through MarkLab without leaving Obsidian.
- Create browser edit links and view links for friends.
- Provide a clear AI handoff path for Codex, Claude Code, Cursor, and similar agents.
- Show whether the current note is hosted, synced, paused, conflicted, or offline.
- Preserve MarkLab's existing local-file, hosted-relay, and conflict semantics.
- Prepare the plugin for eventual Obsidian Community Plugin submission.

## Non-Goals

- Do not port the MarkLab sync engine into the plugin for MVP.
- Do not create a new hosted document workspace.
- Do not add hosted AI write/edit APIs as the primary AI workflow.
- Do not support mobile hosting in the first release.
- Do not silently install the MarkLab CLI or silently start background daemons.
- Do not support arbitrary binary/attachment collaboration in MVP.

## Personas

### Obsidian host

A person writing in Obsidian who wants to share one Markdown note with a friend, collaborator, or AI agent while keeping the note in their vault.

### Friend collaborator

A person who receives a MarkLab browser link and can view or edit the shared Markdown file while the host daemon is online.

### AI collaborator

A local coding or writing agent that edits the Markdown file directly and uses MarkLab CLI commands to checkpoint, wait for sync, and inspect conflicts.

## MVP User Journeys

### Share current note with a friend

1. User opens a Markdown note in Obsidian desktop.
2. User runs `MarkLab: Share current note`.
3. Plugin checks whether the MarkLab CLI is available.
4. If unavailable, plugin shows explicit setup guidance before any install command is run.
5. Plugin asks MarkLab to open or host the file through the local daemon.
6. Plugin creates an edit link or view link.
7. Plugin copies or displays the link.
8. Friend opens the link in a browser.

Acceptance criteria:

- The vault file remains the canonical source.
- User can create separate edit and view links.
- The plugin does not expose local daemon tokens or localhost URLs as share links.
- Closing Obsidian does not mislead the user about hosting state; host online means the MarkLab daemon is running and connected.

### Hand off current note to an AI agent

1. User opens a Markdown note in Obsidian desktop.
2. User runs `MarkLab: Copy AI handoff instructions`.
3. Plugin produces file-specific instructions that tell the agent to edit the local Markdown file directly.
4. Instructions include MarkLab coordination commands for status, save-version, wait, and conflict inspection.

Acceptance criteria:

- Instructions name the local file path.
- Instructions tell the agent to checkpoint before broad edits.
- Instructions tell the agent to stop if MarkLab reports conflict, paused sync, or host offline state.
- Instructions do not direct the agent to mutate hosted relay, Yjs, or database state.

### Check share status

1. User opens a Markdown note in Obsidian desktop.
2. User runs `MarkLab: Show current note status`.
3. Plugin calls MarkLab status/share-state for that file.
4. Plugin shows concise state: not hosted, hosting, synced, paused, conflicted, host offline, or CLI unavailable.

Acceptance criteria:

- Status is scoped to the active note.
- Errors are actionable and human-readable.
- Machine output from MarkLab is parsed rather than scraped from formatted text.

## MVP Plugin Commands

- `MarkLab: Check setup`
- `MarkLab: Share current note`
- `MarkLab: Create edit link for current note`
- `MarkLab: Create view link for current note`
- `MarkLab: Show current note status`
- `MarkLab: Open current note in MarkLab`
- `MarkLab: Copy AI handoff instructions`
- `MarkLab: Stop sharing current note`

The plugin may expose these through the command palette first. Ribbon icons and context-menu entries can follow once the command behavior is stable.

## Settings

MVP settings:

- MarkLab CLI command path, defaulting to `marklab`.
- Hosted relay URL override for self-hosted or development use.
- Default link role: view or edit.
- Background hosting preference.
- Whether to copy created links automatically.

Settings must avoid storing raw local daemon tokens or raw relay access tokens when MarkLab already manages them.

## Technical Requirements

- Add the plugin as a new workspace package only when implementation begins, preferably under `apps/obsidian-plugin`.
- Use the Obsidian sample plugin release shape: `manifest.json`, compiled `main.js`, and optional `styles.css`.
- Use TypeScript.
- Treat Obsidian's `obsidian` package as an external dependency when bundling.
- Use Obsidian APIs to identify the active Markdown file and resolve its vault path.
- Invoke MarkLab through a narrow adapter that can be tested independently from Obsidian UI.
- Parse MarkLab `--json` output for status and link creation.
- Use explicit user confirmation before running setup/install commands or starting persistent background hosting.
- If invoking Node.js, Electron, child processes, or desktop filesystem behavior, set `isDesktopOnly` to `true`.

## Installability Requirements

For local testing:

- Build to `main.js`.
- Place `manifest.json`, `main.js`, and optional `styles.css` in a test vault under `.obsidian/plugins/<plugin-id>/`.
- Enable the plugin from Obsidian Community Plugins.

For beta testing:

- Publish GitHub release assets with a tag matching `manifest.json` version.
- Support BRAT installation from the GitHub repository once release assets are available.

For Community Plugin submission:

- Keep `manifest.json` in the repo root of the plugin package or release-ready plugin repo path expected by the submission flow.
- Ensure plugin `id` is unique and does not contain `obsidian`.
- Include README, LICENSE, and release assets.
- Add an entry to `obsidianmd/obsidian-releases` only after the first working release is ready.

## Policy And Disclosure Requirements

The README for any release candidate must disclose:

- Network use: hosted relay endpoints and why they are needed.
- Filesystem access: active note path, local MarkLab daemon metadata, local versions, and local conflict metadata.
- Account requirements, if paid relay accounts are introduced later.
- Payment requirements, if any hosted capacity requires payment later.
- Server-side telemetry, if operational telemetry is introduced later, with a privacy policy link.

The plugin must not include:

- Client-side telemetry.
- Dynamic internet-loaded ads.
- Code obfuscation intended to hide behavior.
- A plugin self-update mechanism.
- Silent uploads of vault content.
- Silent installation of additional programs.

## Monetization Requirements

The Obsidian plugin should be free to install and use for the MVP.

Future monetization should attach to hosted relay capacity, not to basic plugin installation:

- Free tier for individual Markdown collaboration.
- Paid relay tiers for longer retention, more rooms, more collaborators, attachments, team management, self-hosting support, dedicated hosting, or priority support.
- Optional `fundingUrl` may point to GitHub Sponsors, Buy Me a Coffee, Patreon, or project funding if donation support is desired.

Payment-gated behavior must be disclosed in the README before Community Plugin submission.

## References

- [MarkLab README](../../README.md)
- [Local-first user journeys](../product/local-first-user-journeys.md)
- [Privacy and storage](../production/privacy-and-storage.md)
- [MarkLab agent guide](../agent/marklab-agent-guide.md)
- [Obsidian: Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)
- [Obsidian manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Obsidian developer policies](https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Developer%20policies.md)
- [Obsidian plugin submission requirements](https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Releasing/Submission%20requirements%20for%20plugins.md)
- [Obsidian plugin security](https://obsidian.md/help/plugin-security)
- [Relay product and pricing](https://relay.md/relay)
- [Relay introduction](https://docs.relay.md/introduction/)
