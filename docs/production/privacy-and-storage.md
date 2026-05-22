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

Online version history is part of the hosted copy. It may contain Markdown snapshots until the user or an operator deletes the hosted copy under the product's deletion policy.

## What The Hosted Service Must Not Be

The hosted service is not:

- a reason to overwrite local disk state without conflict review;
- an agent write API;
- a substitute for external backups such as Git, Time Machine, or exported Markdown;
- a reason to recreate deleted local files silently.

AI agents edit local files directly. The active MarkLab.app session ingests those file changes into the shared document when sharing is active.

## Link And Sharing Semantics

An access link is permission. A collaborator session is presence.

Revoking a link removes that grant. It does not delete local files, unrelated links, or unrelated sessions.

`Stop Sharing` returns the app document to local-only mode and asks the server for active access grants before revoking the grants it can manage. It keeps the hosted copy and online version history. After relaunch, older links may be listed without a copyable URL because raw access tokens are not stored after creation; revoke still works from the grant id. If the server grant list is temporarily unavailable, the app falls back to active links known to the current app session.

`Version History` is the user-facing view of hosted snapshots. The native app exposes version history for shared documents. Browser collaborators write into the same provider state and are captured by online checkpoints, but browser version controls are not exposed yet. Shared autosave checkpoints are created every 10 minutes during active editing, plus a final checkpoint after the provider state is stable for 2 minutes; old autosave checkpoints are pruned outside the latest 30 days of that branch's edit timeline.

`Delete Cloud Copy` is the separate destructive action for deleting hosted content and online version history. It is not the same as Stop Sharing and must not delete the user's local Markdown file.

`Clear Local MarkLab Data` should be the separate device/browser privacy and reset action for removing local MarkLab support data and caches. It must not delete hosted content or local Markdown files.

## Missing Local Files

If the local file disappears while watched, MarkLab should pause projection and surface local sync state. It should not silently recreate or overwrite the missing path.

If a collaborator deletes their local app copy, only that app's local projection is affected. Other collaborators and the hosted branch remain separate.
