# Archived Local Daemon Distribution

This page is archived compatibility documentation.

The current pilot uses MarkLab.app plus the hosted `/collab` control-plane/Y-Sweet path. Normal users should not start or depend on the old local daemon route.

## Current Default

Use MarkLab.app:

1. Open a local `.md` file.
2. Click `Start Sharing`.
3. Create an edit or view link.
4. Browser collaborators open `/collab?...mode=edit|view`.
5. App collaborators open the same edit link in MarkLab.app.

Use the CLI only to route hosted edit links into the app:

```bash
marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'
```

The command opens a `marklab://join?...` deep link. View links remain browser-only.

## Archived Compatibility Status

The old daemon CLI commands and the native app's optional daemon boundary have been removed from the active pilot. Historical commands in old plans are reference material only and are not expected to run from the current package.

## Why This Is Archived

The daemon path had two problems for the pilot:

- It made localhost URLs and daemon state look like part of the normal product.
- It created a second collaboration route beside the new hosted `/collab` path.

The new product route is cleaner:

```text
Local .md file
  -> MarkLab.app
  -> Start Sharing
  -> hosted control plane + Y-Sweet provider
  -> /collab browser/app sessions
```

## Future Distribution

Future production distribution should focus on:

- Signed and notarized MarkLab.app.
- A normal installer or DMG.
- Optional Homebrew cask if it improves pilot distribution.
- Hosted login/workspace onboarding.
- Server-backed access-link listing so the app can revoke all active grants after relaunch.
- Native hosted Versions UI.

Homebrew can improve install routing, but it is only a distribution channel. No-warning public or non-technical distribution still requires Developer ID signing and notarization of `MarkLab.app`.

Do not revive the old daemon as the normal distribution path.
