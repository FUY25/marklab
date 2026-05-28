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
- An OIDC-backed MarkLab owner account for hosting/sharing during the private alpha.
- For development builds, this repository and the commands in the manual runbook.

Normal browser collaborators do not need Node, pnpm, Postgres, Docker, or Git.

Browser edit and view links are guest links. Guests do not sign in when they open a browser link. MarkLab.app users do sign in, including app collaborators who open an edit link in the native app.

## Install And Open

Pilot owners should use the MarkLab.app artifact provided by the operator.

1. Unzip the controlled pilot package.
2. Move `MarkLab.app` to `/Applications`.
3. Open `MarkLab.app`.
4. If macOS blocks the current controlled-pilot artifact, use the scoped per-app Gatekeeper workaround only if the operator asks you to:

```sh
xattr -dr com.apple.quarantine /Applications/MarkLab.app
open /Applications/MarkLab.app
```

No-warning public distribution still requires Developer ID signing and notarization, which is tracked for a later gate and is not part of the small controlled pilot.

## Sign In And Workspace

MarkLab.app no longer requires a developer to export `MARKLAB_USER_TOKEN` and `MARKLAB_WORKSPACE_ID` for the normal pilot path.

1. Open MarkLab.app.
2. Open `Settings`.
3. In `Account`, click `Sign In`.
4. Complete the OIDC login in the browser.
5. When the browser offers to open MarkLab, allow it.
6. MarkLab verifies the session, selects an existing workspace, or creates a workspace if none exists.

The signed-in display name from OIDC is also used as the native app collaborator name for cursor/presence display.

If MarkLab.app is signed out, opening a shared app link is blocked with a sign-in message. Browser guest links remain no-login.

## Host Flow In MarkLab.app

1. Open MarkLab.app and sign in if needed.
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

App collaborators sign in before joining. The app uses the signed-in OIDC display name for collaborator presence. Browser guests still appear as guest/browser collaborators.

Through the app:

1. Sign in to MarkLab.app.
2. Open the edit link in MarkLab.app.
3. Choose where the local Markdown file should live.
4. MarkLab joins the shared document and starts projecting provider changes to that local file.

Developer/agent automation can route the same hosted edit link through `marklab join`, but normal pilot collaborators should use the installed app and its shared-link entry point.

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

Operators should use the UI first and should not ask pilot users to paste owner/session tokens into support chats. If an operator needs to check the same state through the API, run it from the ignored local operator environment and avoid echoing the token:

```sh
set -a
source ./.env.marklab-pilot
set +a
curl -fsS -H "Authorization: Bearer $MARKLAB_USER_TOKEN" \
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

## Known Pilot Limitations

- The current app artifact is for a controlled pilot. It may require the scoped Gatekeeper workaround above until signed/notarized distribution is completed.
- Browser collaborators can edit or view through `/collab`, but browser version-control UI is not exposed yet. Their edits still participate in hosted checkpoints through provider writes and autosave.
- Realtime sync and hosted checkpoints are not a public backup/SLA. Keep important files in Git, Time Machine, or another external backup.
- Paid Stripe checkout, payment portal, webhooks, and public pricing are intentionally disabled for the private alpha.
- Workspace/account hard delete and `Clear Local MarkLab Data` are later support/settings actions, not pilot self-serve flows.

## Manual Acceptance

Run the row-by-row acceptance pass in:

[New Relay/Y-Sweet Pilot Runbook](../manual-acceptance/new-relay-pilot.md)

Only the visual/native GUI observations should remain manual after the automated package, Swift, typecheck, Vitest, and smoke suites pass.
