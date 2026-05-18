# Privacy And Storage

MarkLab is local-first from the user's point of view: the native app works with normal Markdown files on disk, while the hosted service coordinates shared sessions.

## What Lives Locally

Local storage includes:

- the Markdown file the user opened or joined;
- native app document state;
- persisted shared-document bindings;
- pending projection/conflict state;
- local backups or external version history the user keeps outside MarkLab.

Stopping sharing, revoking a link, cleanup, or provider expiry must not delete local Markdown files.

## What The Hosted Service Stores

The hosted service may store:

- user/session/workspace metadata;
- document and branch metadata;
- access grants and token hashes;
- collaborator session metadata such as client kind, display name, role, and last seen time;
- version metadata and saved version payloads where the version APIs are used;
- provider document ids and Y-Sweet state in the configured provider store.

Raw access tokens should not be logged or stored. Local file paths should be treated as local/private context and should not be used as a hosted authority boundary.

## What The Hosted Service Must Not Be

The hosted service is not:

- a reason to overwrite local disk state without conflict review;
- an agent write API;
- a substitute for external backup/version history until the native hosted Versions UI is complete;
- a reason to recreate deleted local files silently.

AI agents edit local files directly. The active MarkLab.app session ingests those file changes into the shared document when sharing is active.

## Link And Sharing Semantics

An access link is permission. A collaborator session is presence.

Revoking a link removes that grant. It does not delete local files, unrelated links, or unrelated sessions.

`Stop Sharing` returns the app document to local-only mode and revokes active links known to the current app session. A server-backed all-grants list is required before the app can revoke every historical grant after relaunch.

## Missing Local Files

If the local file disappears while watched, MarkLab should pause projection and surface local sync state. It should not silently recreate or overwrite the missing path.

If a collaborator deletes their local app copy, only that app's local projection is affected. Other collaborators and the hosted branch remain separate.
