# Privacy And Storage

MarkLab is local-first. The local Markdown file is canonical for daemon participants, and the hosted relay is coordination infrastructure.

## What Lives Locally

Local storage includes:

- the Markdown file the user opened or joined;
- local daemon metadata;
- local snapshots and restore metadata;
- local conflict-review state;
- local mirror files created through `marklab join`.

Stopping sharing, revoking a link, relay cleanup, or relay expiry does not delete these files.

## What The Hosted Relay Stores

The hosted relay may store:

- relay room identifiers;
- token hashes for host and access grants;
- access roles such as view or edit;
- access sessions, client kind, display name, and last-seen timestamps;
- host-online/offline state and lease metadata;
- accepted shared revision/hash for stale-conflict detection;
- ephemeral shared state/cache with a TTL.

The alpha TTL for relay ephemeral state is `86400` seconds. TTL expiry means the hosted relay cache is unavailable. It is not document deletion.

Raw relay tokens must not be stored. Local daemon tokens must not be exposed through share-state or production logs.

## What The Hosted Relay Must Not Be

The hosted relay is not:

- the canonical document store;
- a cloud workspace manager;
- a hosted AI write/edit surface;
- a replacement for local snapshots or local restore;
- a reason to recreate deleted local files silently.

AI agents edit local files directly. They use the CLI for status, save-version, wait, conflict inspection, share, revoke, and join coordination.

## Link And Sharing Semantics

Stop sharing removes hosted relay access. It does not delete local files on the host or collaborators' machines.

Revoke link removes access for that grant. It does not delete the local file, the relay room itself, unrelated links, or unrelated sessions.

Relay expiry removes or invalidates hosted metadata/cache according to retention rules. It does not delete local Markdown.

Host online means the daemon is running and connected to the hosted relay. If the host computer sleeps, the network drops, the daemon crashes, or the foreground terminal closes, the relay should mark the host offline after the lease expires.

## Missing Local Files

If the host local file disappears while watched, the daemon should pause hosting and mark the relay host offline or host-file-missing. Remote writes must be rejected instead of silently recreating the host file.

If a collaborator's local mirror file disappears, only that mirror should pause. The host room and other participants must not be mutated.

## Operational Retention

Neon stores relay metadata so links, sessions, grants, revisions, and cleanup can survive process restarts. Operators may clean expired grants, stale sessions, and expired ephemeral cache. Cleanup jobs must never delete, recreate, or mutate local Markdown files because those files are outside the hosted relay's authority.
