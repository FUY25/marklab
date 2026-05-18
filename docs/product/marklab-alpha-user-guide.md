# MarkLab Alpha User Guide

This guide describes the new MarkLab relay/native pilot.

It does not describe the archived local-daemon alpha. The archived daemon commands are disabled by default and require `MARKLAB_ENABLE_LEGACY_CLI=1` only for compatibility testing.

## What MarkLab Does

MarkLab lets people coedit Markdown while keeping a normal local `.md` file in the workflow.

- The native app opens and saves local Markdown files.
- `Start Sharing` creates a shared relay document for that file.
- Browser collaborators edit through `/collab`.
- App collaborators can open the same edit link in MarkLab.app and create their own local file copy.
- MarkLab projects shared changes back to the local file and stops for conflict review when local disk and provider state both diverge.

## Requirements

Pilot users need:

- macOS for MarkLab.app.
- A modern browser for browser collaborators.
- Access to the configured MarkLab API/web origin.
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
   - `Show Collaboration` for access links, active collaborators, and local sync state.
6. Created links are copied to the clipboard automatically.
7. Use `Stop Sharing` when the session should end.

Before sharing, the editor stays local and MarkEdit-style. Sharing controls other than `Start Sharing` stay hidden.

After sharing starts, the persistent state is `Sharing On`. Access-link and collaboration controls appear only then.

## Collaboration Inspector

`Show Collaboration` has three sections.

Access Links:

- Lists active edit/view links known to the app session.
- Shows role, created time, and copy/revoke actions.
- Revoked links disappear from the active list.

Active Collaborators:

- Shows currently connected human browser/app sessions.
- Shows display name, role, client type, and cursor color.
- Agents are not listed as collaborators because they edit through the local file.

Local Sync:

- Shows local file path.
- Shows projection/sync state.
- Shows last synced time when available.
- Shows conflict controls when conflict review is required.

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
- Reopen restores the local binding without using the old daemon.

## Saving

Local-only windows save like a normal document editor. Use `Cmd+S` or the standard save command.

Shared windows additionally project remote shared markdown to disk:

- Remote/provider changes are queued and written to the local file after a short debounce.
- `Cmd+S` flushes pending shared projection immediately.
- If local disk changes and provider changes both diverge, MarkLab pauses projection and opens conflict review.
- `Stop Sharing` flushes pending shared projection before returning the window to local-only mode.

Realtime sync keeps connected editors current. It is not a substitute for version history.

## Version History

The API has version routes for manual save, autosave, list, and restore. Those routes flush active collaboration state before saving or restoring.

The new native relay UI does not yet expose a complete hosted Versions panel. Until it does, pilot users should keep important Markdown files in Git, Time Machine, or another external backup/version system.

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
