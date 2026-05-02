# MarkLab Alpha User Guide

This guide is for people trying the MarkLab hosted-relay alpha with the public npm CLI.

Current public package:

```sh
npx -y @marklab/cli --help
```

As of this alpha, npm installs `@marklab/cli@0.1.0-alpha.5` from the `latest` tag.

## What MarkLab Does

MarkLab lets you share and collaboratively edit a local Markdown file.

The local `.md` file on the host machine is the source of truth. The hosted relay coordinates live collaboration, but it is not a document storage system. If the host daemon is offline, remote editing stops until the host opens MarkLab again.

## Requirements

Normal users need:

- Node.js `20.19` or newer, Node.js `22.12` or newer, or Node.js `24` or newer.
- `npm` and `npx`.
- A modern browser.
- Internet access to install the npm package and reach the hosted relay.

Docker, Postgres, pnpm, Git, and a specific Markdown editor are not required for normal users.

Check Node:

```sh
node --version
npm --version
```

## Important Terms

Local browser URL:

- Looks like `http://127.0.0.1:5175/local#token=...`.
- Works only on the machine running MarkLab.
- Contains private local daemon access.
- Do not share it.

Relay edit link:

- Looks like `https://marklab-relay-alpha.fly.dev/relay/...`.
- Can be used in the browser for editing.
- Can also be used with `marklab join` to create a local Markdown mirror.

Relay view link:

- Browser-only.
- Read-only.
- Cannot create a local mirror with `marklab join`.

## Host Setup

The host is the person who owns the canonical local Markdown file.

The packaged alpha CLI defaults to the hosted relay at `marklab-relay-alpha.fly.dev`. Normal users do not need to export relay URLs before sharing.

Operators and self-hosted testers can override the public relay URLs:

```sh
export MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev
export MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev
export MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay
```

If you want this override to persist for future terminals:

```sh
cat >> ~/.zshrc <<'EOF'
export MARKLAB_PUBLIC_WEB_URL=https://marklab-relay-alpha.fly.dev
export MARKLAB_PUBLIC_API_URL=https://marklab-relay-alpha.fly.dev
export MARKLAB_PUBLIC_RELAY_WS_URL=wss://marklab-relay-alpha.fly.dev/relay
EOF

source ~/.zshrc
```

## Host A File In Background Mode

Use background mode for normal collaboration. It keeps the host daemon running after the command returns:

```sh
npx -y @marklab/cli open README.md --background
```

Create an edit link:

```sh
npx -y @marklab/cli create-link README.md --role edit
```

Create a read-only browser view link:

```sh
npx -y @marklab/cli create-link README.md --role view
```

Check what is running:

```sh
npx -y @marklab/cli status
```

Stop hosting one file:

```sh
npx -y @marklab/cli stop README.md
```

Stop all local MarkLab daemons:

```sh
npx -y @marklab/cli stop --all
```

## Temporary Foreground Sharing

Use foreground sharing for quick tests only. It installs the CLI if needed, starts MarkLab, creates an edit link, and keeps hosting while that terminal stays open:

```sh
npx -y @marklab/cli share README.md
```

Copy the printed `Edit link:` and send it to collaborators.

Keep that terminal open. Closing the terminal stops the host daemon and remote collaborators will be unable to write until the host opens MarkLab again.

## One-Line Collaborator Join

Yes: a collaborator can install the CLI, create the local file, join the shared edit link, and keep a background local mirror running with one command.

```sh
npx -y @marklab/cli join '<edit-link>' --pick-dir --background
```

Replace `<edit-link>` with the relay edit link from the host. MarkLab opens a folder picker so the collaborator can choose where the local file should be created.

If the collaborator prefers typing the folder path instead of using the picker:

```sh
npx -y @marklab/cli join '<edit-link>' --dir ./docs --create-dir --background
```

This command:

- Installs and runs the CLI through `npx`.
- Uses the folder selected in the picker, or creates the typed `--dir` folder when `--create-dir` is used.
- Creates a local Markdown file using the host file name from the edit link.
- Starts a local MarkLab daemon for that mirror file.
- Opens the local MarkLab browser URL for that mirror.
- Returns after the background daemon starts.

To stop that background mirror:

```sh
npx -y @marklab/cli stop <chosen-folder>/<shared-file-name>.md
```

To stop all local MarkLab daemons:

```sh
npx -y @marklab/cli stop --all
```

Foreground join is also available. Omit `--background` and keep the terminal open while you want the mirror to sync. Press `Ctrl-C` when you want to stop listening.

If a file with the same name already exists in the selected folder and is non-empty, MarkLab rejects the join instead of overwriting it. To intentionally replace it:

```sh
npx -y @marklab/cli join '<edit-link>' --pick-dir --replace --background
```

Use `--replace` only when you are sure you want to overwrite the local file.

## Browser Editing

Anyone with an edit link can open the link in a browser and edit while the host is online.

The same edit link can also be used with `marklab join` to create a local Markdown mirror.

Anyone with a view link can open the link in a browser and read, but cannot edit and cannot create a local mirror.

Browser edit and view links work without installing MarkLab. A pure web link cannot install or run a local CLI, create local files, or inspect whether local software is available, because browsers do not have that access. The current safe alpha path is one relay link plus a copyable one-line `npx` command for collaborators who want a local mirror.

## Expected Behavior

Local file is canonical:

- The host's local Markdown file is the source of truth.
- Browser edits are written back to the local file.
- AI tools and editors should edit the local Markdown file directly.

Hosted relay is not storage:

- The relay coordinates live collaboration and stores relay metadata/ephemeral sync state.
- Relay cache expiry is not document deletion.
- Stopping sharing does not delete local files.

Host offline:

- If the host daemon stops, remote browser writes and local mirror writes reject.
- Restarting the host daemon restores editing for valid links.

Missing host file:

- If the host local file is moved or deleted while watched, sync pauses.
- MarkLab does not silently recreate the host file.

Missing collaborator mirror:

- If a collaborator deletes their local mirror file, only that mirror pauses.
- The host file is not deleted.

Revoked links:

- Revoking a link removes access for sessions using that link.
- It does not delete local files.

## Useful Commands

Open a local file in persistent background mode:

```sh
npx -y @marklab/cli open README.md --background
```

Open a local file in temporary foreground mode:

```sh
npx -y @marklab/cli open README.md
```

Create an edit link for an already-open file:

```sh
npx -y @marklab/cli create-link README.md --role edit
```

Create a temporary foreground share:

```sh
npx -y @marklab/cli share README.md
```

Foreground sharing stops when that terminal closes.

Create a view-only browser link:

```sh
npx -y @marklab/cli create-link README.md --role view
```

Show share state:

```sh
npx -y @marklab/cli share-state README.md
```

Revoke a link:

```sh
npx -y @marklab/cli revoke-link README.md <grant-id>
```

Join an edit link as a local mirror:

```sh
npx -y @marklab/cli join '<edit-link>' --pick-dir --background
```

Show running daemons:

```sh
npx -y @marklab/cli status
```

Stop all local daemons:

```sh
npx -y @marklab/cli stop --all
```

## First-Run Notes

The first `npx -y @marklab/cli ...` command can take a minute because npm downloads the CLI and its runtime dependencies. Later runs are usually faster because npm caches the package.

If a command prints a local `127.0.0.1` browser URL, that URL is for your machine only. Do not send it to another person. Send relay edit/view links only.

Share links created by the packaged alpha should point at `https://marklab-relay-alpha.fly.dev`. Local `localhost` or `127.0.0.1` relay links are for development only.

If you intentionally want local relay links while working from this repository, force development mode:

```sh
npx -y @marklab/cli stop --all
export MARKLAB_RELAY_MODE=development
npx -y @marklab/cli open README.md --background
```

## Alpha Limits

This is an alpha. Use it for trials and collaboration tests, not sensitive production documents.

Current alpha assumptions:

- No user account is required for collaborators.
- Anyone with an edit link can edit while the host is online.
- Anyone with a view link can read in the browser.
- The host should keep a backup or version-control history for important Markdown files.
- Windows and Linux should work where Node/npm/browser support is available, but the current manual smoke path has been exercised most heavily on macOS.
