# MarkLab Alpha User Guide

This guide describes the current MarkLab hosted control-plane/Y-Sweet native pilot.

It does not describe the archived local-daemon alpha. The daemon route and old daemon CLI commands have been removed from the active pilot.

## What MarkLab Does

MarkLab lets people coedit Markdown while keeping a normal local `.md` file in the workflow.

- The native app opens and saves local Markdown files.
- `Start Sharing` creates a hosted shared document for that file.
- Browser collaborators edit through `/collab`.
- App collaborators can open the same edit link in MarkLab.app and create their own local file copy.
- MarkLab projects shared changes back to the local file and stops for conflict review when local disk and provider state both diverge.

## Requirements

Pilot users need:

- macOS for MarkLab.app.
- A modern browser for browser collaborators.
- Access to the configured MarkLab API/web origin.
- A MarkLab user token and workspace id for hosting/sharing during the private alpha.
- For development builds, this repository and the commands in the manual runbook.

Normal browser collaborators do not need Node, pnpm, Postgres, Docker, or Git.

## Host Flow In MarkLab.app

1. Open MarkLab.app.
2. Open or create a Markdown file.
3. Edit locally as usual.
4. Click `Start Sharing`.
5. After sharing starts, use:
   - `Create Edit Link` for writable browser/app collaborators.
   - `Create View Link` for read-only browser viewers.
   - `Show Sharing & Versions` for access links, active collaborators, local sync state, retained cloud copy, and online versions.
6. Created links are copied to the clipboard automatically.
7. Use `Stop Sharing` when the session should end.

Before sharing, the editor stays local and MarkEdit-style. The `Sharing & Versions` inspector can still open for local files so the user can see Start Sharing and retained-cloud-copy state.

After sharing starts, the persistent state is `Sharing On`. Access-link, collaborator, local sync, and online version controls appear for the active cloud copy.

## Sharing & Versions Inspector

`Show Sharing & Versions` opens a right inspector with `Sharing` and `Versions` modes.

Sharing mode:

- Lists active edit/view links known to the app session.
- Shows role, created time, and copy/revoke actions.
- Revoked links disappear from the active list.
- Shows currently connected human browser/app sessions.
- Shows display name, role, client type, and cursor color.
- Agents are not listed as collaborators because they edit through the local file.
- Shows local file path.
- Shows projection/sync state.
- Shows last synced time when available.
- Shows conflict controls when conflict review is required.
- Shows `Stop Sharing`, which turns off active sync and revokes active links but keeps the cloud copy and online versions until `Delete Cloud Copy`.

Versions mode:

- Lists online checkpoints for the current shared or retained cloud copy.
- Lets the native app preview and restore a selected snapshot after `RESTORE` confirmation.
- Shows `Delete Cloud Copy` in the Danger Zone after explicit `DELETE CLOUD COPY` confirmation.
- Does not delete the local Markdown file.

## Browser Collaborator Flow

1. Open the edit link in a browser.
2. Confirm the status says connected.
3. Type in the editor.
4. Verify the host app sees the edit.

View links open a rendered read-only document. A view link should not mount the editor and should not accept typing.

## App Collaborator Flow

An edit link can also open in MarkLab.app.

From the CLI:

```sh
npx -y @marklab/cli join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

Or open the same link through the app's shared-link entry point.

Expected behavior:

- MarkLab validates the edit link before creating or mutating a local file.
- MarkLab asks for the destination folder.
- The local filename is the shared document name.
- If a same-name local file is non-empty and is not already bound to that shared document, this pilot slice refuses the join instead of overwriting silently. Attach-to-existing with conflict preview remains the unchecked Plan 6 follow-up.
- Reopen restores the local binding through the hosted document binding.

## Saving

Local-only windows save like a normal document editor by default. Use `Cmd+S` or the standard save command.

The app Settings window has an `Autosave Local Files` setting. It only applies when a file is not sharing. When sharing is on, MarkLab syncs automatically and creates online version checkpoints.

Shared windows additionally project remote shared markdown to disk:

- Remote/provider changes are queued and written to the local file after a short debounce.
- `Cmd+S` creates a manual online checkpoint and flushes pending shared projection immediately.
- If local disk changes and provider changes both diverge, MarkLab pauses projection and opens conflict review.
- `Stop Sharing` flushes pending shared projection before returning the window to local-only mode.

Realtime sync keeps connected editors current. It is not a substitute for version history.

## Version History

The native `Sharing & Versions` inspector exposes online version history for shared documents.

Shared documents create online checkpoints from the active provider state. `Save Checkpoint` and `Cmd+S` create manual checkpoints from the current shared state; server-side autosave creates automatic checkpoints every 10 minutes during active editing, plus a final checkpoint after the provider state is stable for 2 minutes. The Versions panel lists checkpoints, previews the selected snapshot, and restores a selected version only after confirmation. Restore creates a new rollback checkpoint instead of mutating old snapshots.

Browser collaborators participate in the same shared provider state and their edits are captured by online checkpoints, but the browser surface does not expose version controls yet. Pilot users should still keep important Markdown files in Git, Time Machine, or another external backup/version system.

## Plan And Billing

The private alpha runs in manual/free mode. Stripe checkout, payment portal, webhooks, and paid-plan choices are not enabled.

Workspace settings includes a `Plan & Billing` tab so owners and members can inspect the current plan, member-seat usage, and concurrent guest-edit usage. The tab is read-only for the private alpha. The control plane still enforces member-seat and guest-edit limits before issuing collaborator access or provider tokens.

Operators can check the same state through:

```sh
curl -H "Authorization: Bearer <ml_user_...>" \
  https://marklab-relay-alpha.fly.dev/api/workspaces/<workspace-id>/billing
```

## Links And Revocation

An access link is a permission grant. A collaborator session is presence. A cursor color belongs to the active collaborator session, not to the link itself.

One edit link can be used by more than one person, so the link list and active collaborator list are intentionally separate.

Revoking a link removes that grant. It does not delete local files.

`Stop Sharing` refreshes active grants from the server, revokes active branch links it can manage, and returns the document to local-only editing. Links created before the current app session may be listed without a copyable URL because raw access tokens are not stored after creation; revoke still works from the grant id.

## Missing Files And Conflicts

If the local `.md` file is deleted or moved while the app is open, MarkLab should pause projection and show local sync state instead of recreating the file silently.

If the local disk file and shared provider state both changed independently, MarkLab should show conflict review before writing either side over the other.

## Manual Acceptance

Run the row-by-row acceptance pass in:

[New Relay/Y-Sweet Pilot Runbook](../manual-acceptance/new-relay-pilot.md)

Only the visual/native GUI observations should remain manual after the automated package, Swift, typecheck, Vitest, and smoke suites pass.
