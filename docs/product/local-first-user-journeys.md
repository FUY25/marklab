# Local-First User Journeys

These journeys describe the current hosted native/Y-Sweet pilot.

## Local Editing

1. User opens a `.md` file in MarkLab.app.
2. MarkLab shows the MarkEdit-style local editor.
3. User edits locally.
4. User saves with `Cmd+S` or the standard save command.
5. The file remains a normal Markdown file on disk.

Before sharing, the editor stays local. The `Sharing & Versions` inspector can still show local sharing readiness and retained-cloud-copy state when applicable.

## Start Sharing

1. User clicks `Start Sharing`.
2. MarkLab imports or creates the shared document through the hosted control plane.
3. MarkLab opens an app-kind `/collab` session for the same document branch.
4. The local editor keeps the same visual layer and gains collaboration behavior.
5. Sharing controls appear: create edit link, create view link, Show Sharing & Versions, and Stop Sharing.

## Browser Collaborator

1. Host creates an edit link.
2. Browser collaborator opens `/collab?...mode=edit`.
3. Browser edits converge with the app session through Y-Sweet.
4. MarkLab.app projects shared markdown to the local `.md` file.
5. Cursor/presence appears for connected human sessions.

## App Collaborator

1. Host creates an edit link.
2. Collaborator opens the same link in MarkLab.app.
3. MarkLab validates the link.
4. Collaborator chooses a destination folder.
5. MarkLab creates a local `.md` using the shared document name.
6. App collaborator and host coedit through the same shared document.
7. Each app maintains its own local file projection.

## View-Only Collaborator

1. Host creates a view link.
2. Viewer opens `/collab?...mode=view`.
3. The browser renders a read-only document.
4. The editable editor must not mount.
5. The viewer does not appear as editable presence.

## Agent Edit

1. Agent edits the local `.md` file directly.
2. MarkLab.app observes the disk change.
3. If the provider text still matches the expected baseline, MarkLab ingests the file change into shared state.
4. If disk and provider both diverged, MarkLab opens conflict review.

Agents do not appear in the collaborator list.

## Missing Local File

1. User deletes or moves the local file while sharing.
2. MarkLab pauses local projection.
3. The UI reports local sync state.
4. MarkLab does not silently recreate the missing file.

## Stop Sharing

1. User clicks `Stop Sharing`.
2. MarkLab flushes pending shared projection to disk.
3. MarkLab refreshes active branch grants from the server and revokes the active links it can manage.
4. MarkLab clears active collaborator state and shared binding.
5. The window returns to local-only editing.

Stopping sharing does not delete local files, the retained cloud copy, or online version history. `Delete Cloud Copy` is the separate destructive hosted-content action.
