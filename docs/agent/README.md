# MarkLab Agent Docs

This directory is the operating manual for local coding agents that work with the current MarkLab relay/native pilot.

- [Agent guide](marklab-agent-guide.md)
- [Codex instructions](marklab-codex-instructions.md)
- [Claude Code instructions](marklab-claude-code-instructions.md)
- [Cursor instructions](marklab-cursor-instructions.md)

The short version: agents edit the local Markdown file on disk. MarkLab.app watches that file and syncs it into the shared `/collab` document. Agents do not appear as collaborators and should not use hosted mutation endpoints or access tokens as a write API.

The old daemon CLI status/wait/version/conflict commands are archived compatibility commands until they are rebound to the new relay/native session model.
