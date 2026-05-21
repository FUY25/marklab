# Local URL vs Shared URL

MarkLab has two different URL concepts. They must stay separate.

## Local App State

In the current relay/native pilot, local app state lives inside MarkLab.app and the local Markdown file. Normal users should not receive or share private localhost editor URLs.

Local app state includes:

- the opened `.md` file;
- the native editor state;
- the persisted shared-document binding;
- pending local projection/conflict state.

## Shared `/collab` URL

A shared URL is the normal collaborator URL:

```text
https://<host>/collab?docId=...&branchId=...&token=...&mode=edit
```

or:

```text
https://<host>/collab?docId=...&branchId=...&token=...&mode=view
```

It represents a control-plane access grant for one document branch.

- Edit links can be opened in a browser or in MarkLab.app.
- View links are browser-only.
- The URL does not expose local files or localhost app state.
- The token is permission, not presence. Active collaborator identity and cursor color come from connected sessions.

## Native Deep Link

The CLI can turn a hosted edit link into a native app deep link:

```text
marklab://join?url=<encoded-collab-url>
```

MarkLab.app validates the embedded edit link before creating or mutating a local file. View links are rejected by the native join flow.

## Archived Local URL

The old daemon alpha used private URLs like:

```text
http://127.0.0.1:<port>/local#token=...
```

That path is archived behavior and is not part of the current pilot. Do not send localhost URLs to collaborators.
