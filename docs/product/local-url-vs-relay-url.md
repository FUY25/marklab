# Local URL vs Relay URL

MarkLab has two different URL concepts. They must stay separate.

## Local URL

A local URL is printed by the local daemon:

```text
http://127.0.0.1:5175/local#token=...
```

It is private to the host machine.

- It points at a loopback-only web server.
- It carries daemon access in the URL fragment.
- The browser stores that token in session storage.
- It can read and edit the opened local Markdown file.
- It must not be shared with collaborators.

The token is scoped to one daemon process and one opened file.

## Relay URL

A relay URL is the shareable collaboration URL introduced after Plan 01.

- It is safe to send to another person when the host chooses to share.
- It represents relay identity, permissions, and transport.
- It does not expose the private local daemon URL.
- It does not make the host file globally addressable by default.

The relay may coordinate live transport, but the local `.md` file remains canonical for a local-first session.

## View Link

A view link is browser-only.

- The recipient can inspect the shared document in the browser.
- It does not grant local mirror participation.
- It does not grant access to the host's local daemon.

## Edit Link

An edit link can support two collaboration modes in later plans.

- Browser edit: the recipient edits in the browser through relay permissions.
- Local mirror join: the recipient connects a local Markdown file to the shared session.

Plan 01 implements neither relay link. It only makes the private local URL safe and useful for one host file.
