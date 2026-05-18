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

## Archived Compatibility Opt-In

The old daemon CLI commands are disabled by default.

For archived compatibility testing only:

```bash
MARKLAB_ENABLE_LEGACY_CLI=1 marklab status
MARKLAB_ENABLE_LEGACY_CLI=1 marklab open README.md --background
MARKLAB_ENABLE_LEGACY_CLI=1 marklab create-link README.md --role edit
MARKLAB_ENABLE_LEGACY_CLI=1 marklab stop --all
```

The native app also keeps its legacy local daemon boundary disabled unless explicitly enabled:

```bash
MARKLAB_APP_ENABLE_LOCAL_DAEMON_BOUNDARY=1
```

Do not enable that boundary for the new relay/native pilot unless you are testing archived behavior.

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

Do not revive the old daemon as the normal distribution path.
