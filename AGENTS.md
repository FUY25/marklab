# MarkLab Agent Instructions

These instructions apply to coding agents working in this repository.

## Product North Star

MarkLab is local-first Markdown collaboration. The local `.md` file is the canonical document for users running the local daemon or Obsidian desktop host. Browser views, share links, relay rooms, versions, and AI coordination exist to protect and coordinate that file, not to replace it with a cloud document workspace.

For the Obsidian plugin direction, the first product shape is a thin Obsidian-native control panel over the existing MarkLab CLI, daemon, browser UI, and hosted relay.

## Agent Operating Rules

- Treat the local Markdown file as the write surface.
- Use MarkLab CLI commands for coordination: `status`, `wait`, `save-version`, `versions`, `conflict`, `share-state`, `create-link`, and `revoke-link`.
- Before broad or high-risk edits to a shared file, create a MarkLab version checkpoint.
- After editing a watched file, wait for MarkLab sync before reporting completion.
- If MarkLab reports `paused`, `hasConflict`, `host_offline`, or `sync_paused`, stop editing the watched file and surface the state to the user.
- Do not mutate hosted relay state, Yjs state, Postgres rows, or Fly/Neon infrastructure directly unless the task is explicitly operational and scoped to those systems.
- Do not add hosted AI write/edit APIs as the primary agent workflow. Agents should edit files locally and let MarkLab synchronize.

Useful commands:

```sh
marklab status <file.md> --json
marklab save-version <file.md> --message "Before AI edit: <reason>" --json
marklab wait <file.md> --synced --timeout 10000 --json
marklab conflict <file.md> --json
marklab create-link <file.md> --role edit --json
marklab create-link <file.md> --role view --json
marklab share-state <file.md> --json
```

## Obsidian Plugin Rules

Obsidian plugin work must follow the official plugin policies and review expectations:

- Disclose network use, account requirements, payment requirements, filesystem access outside the vault, server-side telemetry, static ads, and closed-source code in the README when applicable.
- Do not add client-side telemetry.
- Do not add dynamic ads loaded from the internet.
- Do not add plugin self-update mechanisms.
- Do not obfuscate code to hide its purpose.
- Use safe Obsidian APIs and DOM helpers instead of unsafe HTML injection.
- Use `this.app` instead of the global `app`.
- Use the Vault and Editor APIs for vault files when possible.
- Use `normalizePath()` for user-provided vault paths.
- Clean up plugin resources through registered events, commands, and unload handlers.
- Use Obsidian CSS variables and classes instead of hardcoded inline styling.
- If the plugin invokes Node.js, Electron, child processes, local CLI commands, or filesystem behavior unavailable on mobile, set `isDesktopOnly` to `true` in `manifest.json`.

## Obsidian Plugin MVP Boundaries

The first Obsidian plugin branch should not port the MarkLab sync engine into the plugin. It should provide Obsidian-native commands and settings around the existing CLI/daemon:

- Check whether MarkLab CLI is available.
- Offer explicit user-approved setup instructions or install flow.
- Share the active Markdown note.
- Create edit and view links.
- Show host/share status for the active note.
- Copy AI handoff instructions for the active note.
- Open the MarkLab browser editor for the active note.

The plugin should not silently install tools, silently start background daemons, or upload vault content without an explicit user action.

## Verification

Before finishing code changes, run the narrowest relevant checks:

```sh
pnpm test
pnpm typecheck
```

If a change only touches documentation, inspect the rendered Markdown structure and verify links/paths manually. State clearly if dependency installation or test execution was skipped.
